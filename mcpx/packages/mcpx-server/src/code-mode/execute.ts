import { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { Logger } from "winston";
import z from "zod/v4";
import { ToolCallResultUnion } from "../model/sessions.js";
import { ApprovalRequester } from "./approval.js";
import {
  classifyReadOnlyCall,
  classifyToolCall,
  CodeModeLimits,
  CodeModeTrustPolicy,
} from "./policy.js";
import {
  runSandbox,
  SandboxLog,
  SandboxOutcome,
  SandboxReply,
  SandboxRequest,
} from "./sandbox.js";
import { CODE_MODE_RESERVED_TOOL_NAMES } from "./tool.js";

export type GatewayRejectionCode =
  | "not_available"
  | "permission_denied"
  | "server_inactive"
  | "target_changed"
  | "session_closed"
  | "identity_changed";

export type ResolvedCall =
  | {
      ok: true;
      serverName: string;
      origin: string;
      definition: Tool;
      // opaque fingerprint of the route, definition, auth generation and caller
      binding: string;
    }
  | { ok: false; code: GatewayRejectionCode; message: string };

export type DispatchOutcome =
  | { kind: "result"; result: ToolCallResultUnion }
  | { kind: "rejected"; code: GatewayRejectionCode; message: string };

export type DiscoveryTool =
  | "mcpx_list_servers"
  | "mcpx_search_tools"
  | "mcpx_get_tool_schema";

/*
 * The caller's live view of the gateway. Every method evaluates permissions
 * and visibility for the outer session at the moment it runs, so catalog
 * changes, new servers and revocations apply to the next inner call.
 */
export interface CodeModeGateway {
  // a rejection means the caller can no longer use the gateway at all
  discover(
    tool: DiscoveryTool,
    args: Record<string, unknown>,
  ): Promise<CallToolResult | Extract<ResolvedCall, { ok: false }>>;
  resolve(name: string): ResolvedCall;
  /*
   * The normal gateway dispatch. It re-resolves the target and runs it only
   * when its binding still equals the one that was classified and approved;
   * any change rejects without calling the tool.
   */
  dispatch(
    name: string,
    args: Record<string, unknown>,
    binding: string,
  ): Promise<DispatchOutcome>;
}

type CallStatus =
  | "pending"
  | "awaiting_approval"
  | "running"
  | "succeeded"
  | "tool_error"
  | "failed"
  | "rejected"
  | "declined"
  | "not_started"
  | "in_flight";

interface CallReport {
  index: number;
  tool: string;
  status: CallStatus;
  approval?: "trusted_read" | "user_approved";
  errorCode?: string;
  outcome?: "unknown";
  // UTF-8 bytes of the result MCPX received, present only when one arrived
  resultBytes?: number;
  resultWithheld?: boolean;
  durationMs?: number;
}

/*
 * UTF-8 byte counts at two boundaries. `received` is a reply MCPX got from a
 * tool or from discovery, measured on the JSON it builds for the script;
 * `sent` is the part that MCPX actually sent to the runner process, so a
 * withheld oversized reply, or one ready only after the script stopped,
 * counts as received only. Neither includes the broker envelope, the
 * guest-side `text` and `data` copies, or refusals and error replies.
 */
interface ByteCounts {
  received: number;
  sent: number;
}

interface ExecuteCodeProps {
  code: string;
  runnerPath: string;
  limits: CodeModeLimits;
  trust: CodeModeTrustPolicy;
  // only trusted reads run; set for mcpx_execute_readonly
  readOnly?: boolean;
  gateway: CodeModeGateway;
  approve?: ApprovalRequester;
  signal?: AbortSignal;
  logger: Logger;
  executionId: string;
}

const callPayloadSchema = z
  .object({
    name: z.string().min(1).max(500),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

// a reply is `{"ok":true,"value":<value JSON>}`; sizes exclude this wrapper
const REPLY_ENVELOPE_BYTES = Buffer.byteLength('{"ok":true,"value":}');

const FAILURE_NOTE =
  "Some tool calls started before the script stopped. MCPX never retries calls or scripts automatically; check each call's status before retrying anything.";

export async function executeCode(
  props: ExecuteCodeProps,
): Promise<CallToolResult> {
  const { code, runnerPath, limits, trust, gateway, approve, signal, logger } =
    props;
  const readOnly = props.readOnly === true;
  const startedAt = Date.now();
  const deadline = startedAt + limits.wallMs;
  const calls: CallReport[] = [];
  const logs: SandboxLog[] = [];
  const slots = new Slots(limits.maxConcurrentCalls);
  // one approval prompt at a time, so the user never faces a stack of questions
  const approvals = new Slots(1);
  let callsOverLimit = 0;
  let discoveryRequests = 0;
  let pendingRequests = 0;
  const toolBytes: ByteCounts = { received: 0, sent: 0 };
  const discoveryBytes: ByteCounts = { received: 0, sent: 0 };
  const counted = (
    counts: ByteCounts,
    valueText: string,
    valueBytes: number,
  ): SandboxReply => ({
    payload: okReply(valueText),
    onSent: (): void => {
      counts.sent += valueBytes;
    },
  });

  const handleCall = async (
    payload: unknown,
    stopped: AbortSignal,
  ): Promise<SandboxReply> => {
    const parsed = callPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return failure(
        "invalid_arguments",
        "mcpx.callTool needs a tool name and a plain object of arguments",
      );
    }
    const { name, arguments: args } = parsed.data;
    if (CODE_MODE_RESERVED_TOOL_NAMES.has(name)) {
      return failure(
        "recursion_blocked",
        `${name} is a gateway wrapper; call the target tool by its own name`,
      );
    }
    if (stopped.aborted) return failure("cancelled", "The script stopped");
    if (calls.length >= limits.maxToolCalls) {
      callsOverLimit += 1;
      return failure(
        "call_limit",
        `The script reached its limit of ${limits.maxToolCalls} tool calls`,
      );
    }
    const report: CallReport = {
      index: calls.length + 1,
      tool: name,
      status: "pending",
    };
    calls.push(report);

    const release = await slots.acquire(stopped);
    if (!release) return failure("cancelled", "The script stopped");
    try {
      if (stopped.aborted) return failure("cancelled", "The script stopped");
      const resolved = gateway.resolve(name);
      if (!resolved.ok) {
        report.status = "rejected";
        report.errorCode = resolved.code;
        return failure(resolved.code, resolved.message);
      }
      const target = {
        name,
        serverName: resolved.serverName,
        origin: resolved.origin,
        definition: resolved.definition,
        trust,
      };
      if (readOnly) {
        const decision = classifyReadOnlyCall(target);
        if (decision.kind === "blocked") {
          report.status = "rejected";
          report.errorCode = "read_only_blocked";
          return failure(
            "read_only_blocked",
            decision.reason === "declares-write"
              ? `${name} declares that it can change state, so mcpx_execute_readonly does not run it`
              : `${name} is not a read that this gateway trusts, so mcpx_execute_readonly does not run it`,
          );
        }
        // read-only mode never asks; it runs trusted reads only
        report.approval = "trusted_read";
      } else if (
        approve &&
        classifyToolCall(target).kind === "approval-required"
      ) {
        report.status = "awaiting_approval";
        const releaseApproval = await approvals.acquire(stopped);
        if (!releaseApproval) return failure("cancelled", "The script stopped");
        let decision: Awaited<ReturnType<ApprovalRequester>>;
        try {
          decision = await approve({
            request: {
              callIndex: report.index,
              toolName: name,
              serverName: resolved.serverName,
              arguments: args,
            },
            signal: stopped,
            timeoutMs: Math.max(
              1,
              Math.min(limits.approvalTimeoutMs, deadline - Date.now()),
            ),
          });
        } finally {
          releaseApproval();
        }
        if (!decision.approved && stopped.aborted) {
          // the script ended while the question was open; nobody declined
          report.status = "not_started";
          return failure("cancelled", "The script stopped");
        }
        if (!decision.approved) {
          report.status = "declined";
          report.errorCode = decision.code;
          logger.info("Code Mode call not approved", {
            executionId: props.executionId,
            callIndex: report.index,
            toolName: name,
            code: decision.code,
          });
          return failure(decision.code, decision.message);
        }
        report.approval = "user_approved";
      } else if (approve) {
        report.approval = "trusted_read";
      }
      if (stopped.aborted) {
        report.status = "not_started";
        return failure("cancelled", "The script stopped");
      }

      report.status = "running";
      const callStartedAt = Date.now();
      let outcome: DispatchOutcome;
      try {
        outcome = await gateway.dispatch(name, args, resolved.binding);
      } catch (error) {
        report.status = "failed";
        report.outcome = "unknown";
        report.durationMs = Date.now() - callStartedAt;
        return failure(
          "call_failed",
          `The call failed and its outcome is unknown; MCPX did not retry it: ${error instanceof Error ? error.message : String(error)}`,
          { outcome: "unknown" },
        );
      }
      report.durationMs = Date.now() - callStartedAt;
      if (outcome.kind === "rejected") {
        report.status = "rejected";
        report.errorCode = outcome.code;
        return failure(outcome.code, outcome.message);
      }
      const value = projectResult(outcome.result);
      report.status = value.isError ? "tool_error" : "succeeded";
      const valueText = JSON.stringify(value);
      const valueBytes = Buffer.byteLength(valueText);
      report.resultBytes = valueBytes;
      toolBytes.received += valueBytes;
      if (valueBytes + REPLY_ENVELOPE_BYTES > limits.maxToolResultBytes) {
        report.resultWithheld = true;
        return failure(
          "result_too_large",
          `The call completed, but its result exceeds ${limits.maxToolResultBytes} bytes and was withheld. Do not repeat it to get the result; request less data instead.`,
          { outcome: "completed" },
        );
      }
      return counted(toolBytes, valueText, valueBytes);
    } finally {
      release();
    }
  };

  const handleDiscovery = async (
    tool: DiscoveryTool,
    args: Record<string, unknown>,
    stopped: AbortSignal,
  ): Promise<SandboxReply> => {
    if (discoveryRequests >= limits.maxDiscoveryRequests) {
      return failure(
        "discovery_limit",
        `The script reached its limit of ${limits.maxDiscoveryRequests} discovery requests`,
      );
    }
    discoveryRequests += 1;
    const release = await slots.acquire(stopped);
    if (!release) return failure("cancelled", "The script stopped");
    try {
      if (stopped.aborted) return failure("cancelled", "The script stopped");
      const reply = await discover(gateway, tool, args);
      if (!reply.ok) return reply.failure;
      const valueBytes = Buffer.byteLength(reply.valueText);
      discoveryBytes.received += valueBytes;
      if (valueBytes + REPLY_ENVELOPE_BYTES > limits.maxToolResultBytes) {
        return failure(
          "result_too_large",
          `The discovery result exceeds ${limits.maxToolResultBytes} bytes`,
        );
      }
      return counted(discoveryBytes, reply.valueText, valueBytes);
    } finally {
      release();
    }
  };

  const onRequest = async (
    request: SandboxRequest,
    stopped: AbortSignal,
  ): Promise<SandboxReply> => {
    if (stopped.aborted) return failure("cancelled", "The script stopped");
    if (pendingRequests >= limits.maxPendingRequests) {
      return failure(
        "too_many_pending_requests",
        `The script has ${limits.maxPendingRequests} unanswered requests; await some before sending more`,
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(request.payload);
    } catch {
      return failure("invalid_arguments", "The request is not valid JSON");
    }
    pendingRequests += 1;
    try {
      switch (request.op) {
        case "call":
          return await handleCall(payload, stopped);
        case "servers":
          return await handleDiscovery("mcpx_list_servers", {}, stopped);
        case "search":
          return await handleDiscovery(
            "mcpx_search_tools",
            asRecord(payload),
            stopped,
          );
        case "schema":
          return await handleDiscovery(
            "mcpx_get_tool_schema",
            asRecord(payload),
            stopped,
          );
      }
    } finally {
      pendingRequests -= 1;
    }
  };

  logger.info("Code Mode execution started", {
    executionId: props.executionId,
    readOnly,
    codeBytes: Buffer.byteLength(code),
  });
  const outcome = await runSandbox({
    runnerPath,
    code,
    limits,
    signal,
    onRequest,
    onLog: (log) => logs.push(log),
  });

  // snapshot now: a call still in flight must not add to the report later;
  // nothing is sent to the runner after it stopped
  const finalCalls = calls.map(finalizeReport);
  const ok = outcome.status === "completed";
  const logLines = logs.map(({ level, text }) =>
    level === "log" ? text : `[${level}] ${text}`,
  );
  const bytes = {
    toolResults: { ...toolBytes },
    discovery: { ...discoveryBytes },
    // the returned value's JSON; absent when the script failed
    ...(outcome.status === "completed"
      ? { result: Buffer.byteLength(outcome.result) }
      : {}),
    logs: logLines.reduce((sum, line) => sum + Buffer.byteLength(line), 0),
  };
  const output = {
    ok,
    ...(readOnly ? { readOnly: true } : {}),
    ...(outcome.status === "completed"
      ? { result: JSON.parse(outcome.result) as unknown }
      : { error: describeOutcome(outcome, limits) }),
    calls: finalCalls,
    ...(callsOverLimit > 0 ? { callsOverLimit } : {}),
    ...(logLines.length > 0 ? { logs: logLines } : {}),
    ...(!ok && finalCalls.some((call) => wasStarted(call.status))
      ? { note: FAILURE_NOTE }
      : {}),
    bytes,
    wallMs: Date.now() - startedAt,
  };
  logger.info("Code Mode execution finished", {
    executionId: props.executionId,
    readOnly,
    status: outcome.status,
    calls: finalCalls.map(({ tool, status, approval, errorCode }) => ({
      tool,
      status,
      approval,
      errorCode,
    })),
    bytes,
  });
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    ...(ok ? {} : { isError: true }),
  };
}

function finalizeReport(report: CallReport): CallReport {
  switch (report.status) {
    case "running":
      return { ...report, status: "in_flight", outcome: "unknown" };
    case "pending":
    case "awaiting_approval":
      return { ...report, status: "not_started" };
    case "succeeded":
    case "tool_error":
    case "failed":
    case "rejected":
    case "declined":
    case "not_started":
    case "in_flight":
      return { ...report };
  }
}

function wasStarted(status: CallStatus): boolean {
  return (
    status === "succeeded" ||
    status === "tool_error" ||
    status === "failed" ||
    status === "in_flight"
  );
}

function describeOutcome(
  outcome: Exclude<SandboxOutcome, { status: "completed" }>,
  limits: CodeModeLimits,
): { code: string; message: string } {
  switch (outcome.status) {
    case "timeout":
      return {
        code: "wall_timeout",
        message: `The script exceeded ${limits.wallMs} ms and was stopped`,
      };
    case "cancelled":
      return { code: "cancelled", message: "The request was cancelled" };
    case "crashed":
      return { code: "runner_failed", message: outcome.detail };
    case "failed": {
      const { name, message, reason } = outcome.error;
      const code =
        reason === "cpu"
          ? "cpu_limit"
          : reason === "memory"
            ? "memory_limit"
            : reason === "stack"
              ? "stack_limit"
              : reason === "deadlock"
                ? "deadlock"
                : reason === "result"
                  ? "result_too_large"
                  : reason === "internal"
                    ? "runner_failed"
                    : "script_error";
      return { code, message: `${name}: ${message}` };
    }
  }
}

function projectResult(result: ToolCallResultUnion): {
  isError: boolean;
  content: unknown[];
  structuredContent?: unknown;
} {
  if ("content" in result && Array.isArray(result.content)) {
    return {
      isError: result.isError === true,
      content: result.content,
      ...(result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent }
        : {}),
    };
  }
  return {
    isError: false,
    content: [],
    structuredContent: "toolResult" in result ? result.toolResult : undefined,
  };
}

// the discovery text is the same JSON a direct discovery call returns
async function discover(
  gateway: CodeModeGateway,
  tool: DiscoveryTool,
  args: Record<string, unknown>,
): Promise<{ ok: true; valueText: string } | { ok: false; failure: string }> {
  const result = await gateway.discover(tool, args);
  if (isRejection(result)) {
    return { ok: false, failure: failure(result.code, result.message) };
  }
  const first = result.content[0];
  const text = first?.type === "text" ? first.text : "";
  if (result.isError) {
    return { ok: false, failure: failure("invalid_request", text) };
  }
  // reject a reply that is not one JSON value before it is spliced into the envelope
  JSON.parse(text);
  return { ok: true, valueText: text };
}

function isRejection(
  value: CallToolResult | Extract<ResolvedCall, { ok: false }>,
): value is Extract<ResolvedCall, { ok: false }> {
  return "ok" in value && value.ok === false;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function okReply(valueText: string): string {
  return `{"ok":true,"value":${valueText}}`;
}

function failure(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({ ok: false, error: { code, message, ...extra } });
}

// FIFO slots that release waiters on abort without granting them
class Slots {
  private readonly waiters = new Set<() => void>();
  private available: number;

  constructor(capacity: number) {
    this.available = capacity;
  }

  acquire(signal: AbortSignal): Promise<(() => void) | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve) => {
      const grant = (): void => {
        signal.removeEventListener("abort", onAbort);
        resolve(this.releaser());
      };
      const onAbort = (): void => {
        this.waiters.delete(grant);
        resolve(undefined);
      };
      this.waiters.add(grant);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.values().next();
      if (next.done) {
        this.available += 1;
        return;
      }
      this.waiters.delete(next.value);
      next.value();
    };
  }
}
