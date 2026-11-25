import { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { Logger } from "winston";
import z from "zod/v4";
import { ToolCallResultUnion } from "../model/sessions.js";
import { ApprovalRequester } from "./approval.js";
import {
  classifyToolCall,
  CodeModeLimits,
  CodeModeTrustPolicy,
} from "./policy.js";
import {
  runSandbox,
  SandboxLog,
  SandboxOutcome,
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
  resultWithheld?: boolean;
  durationMs?: number;
}

interface ExecuteCodeProps {
  code: string;
  runnerPath: string;
  limits: CodeModeLimits;
  trust: CodeModeTrustPolicy;
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

const FAILURE_NOTE =
  "Some tool calls started before the script stopped. MCPX never retries calls or scripts automatically; check each call's status before retrying anything.";

export async function executeCode(
  props: ExecuteCodeProps,
): Promise<CallToolResult> {
  const { code, runnerPath, limits, trust, gateway, approve, signal, logger } =
    props;
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

  const handleCall = async (
    payload: unknown,
    stopped: AbortSignal,
  ): Promise<string> => {
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
      const classification = classifyToolCall({
        name,
        serverName: resolved.serverName,
        origin: resolved.origin,
        definition: resolved.definition,
        trust,
      });
      if (approve && classification.kind === "approval-required") {
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
      const text = JSON.stringify({ ok: true, value });
      if (Buffer.byteLength(text) > limits.maxToolResultBytes) {
        report.resultWithheld = true;
        return failure(
          "result_too_large",
          `The call completed, but its result exceeds ${limits.maxToolResultBytes} bytes and was withheld. Do not repeat it to get the result; request less data instead.`,
          { outcome: "completed" },
        );
      }
      return text;
    } finally {
      release();
    }
  };

  const handleDiscovery = async (
    tool: DiscoveryTool,
    args: Record<string, unknown>,
    stopped: AbortSignal,
  ): Promise<string> => {
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
      const text = await discover(gateway, tool, args);
      if (Buffer.byteLength(text) > limits.maxToolResultBytes) {
        return failure(
          "result_too_large",
          `The discovery result exceeds ${limits.maxToolResultBytes} bytes`,
        );
      }
      return text;
    } finally {
      release();
    }
  };

  const onRequest = async (
    request: SandboxRequest,
    stopped: AbortSignal,
  ): Promise<string> => {
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

  const finalCalls = calls.map(finalizeReport);
  const ok = outcome.status === "completed";
  const output = {
    ok,
    ...(outcome.status === "completed"
      ? { result: JSON.parse(outcome.result) as unknown }
      : { error: describeOutcome(outcome, limits) }),
    calls: finalCalls,
    ...(callsOverLimit > 0 ? { callsOverLimit } : {}),
    ...(logs.length > 0
      ? {
          logs: logs.map(({ level, text }) =>
            level === "log" ? text : `[${level}] ${text}`,
          ),
        }
      : {}),
    ...(!ok && finalCalls.some((call) => wasStarted(call.status))
      ? { note: FAILURE_NOTE }
      : {}),
    wallMs: Date.now() - startedAt,
  };
  logger.info("Code Mode execution finished", {
    executionId: props.executionId,
    status: outcome.status,
    calls: finalCalls.map(({ tool, status, approval }) => ({
      tool,
      status,
      approval,
    })),
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

async function discover(
  gateway: CodeModeGateway,
  tool: DiscoveryTool,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await gateway.discover(tool, args);
  if (isRejection(result)) return failure(result.code, result.message);
  const first = result.content[0];
  const text = first?.type === "text" ? first.text : "";
  if (result.isError) return failure("invalid_request", text);
  return JSON.stringify({ ok: true, value: JSON.parse(text) as unknown });
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
