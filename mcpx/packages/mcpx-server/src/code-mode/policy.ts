import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { CODE_MODE_RESERVED_TOOL_NAMES } from "./tool.js";

export interface CodeModeLimits {
  cpuMs: number;
  wallMs: number;
  memoryBytes: number;
  stackBytes: number;
  runnerHeapMb: number;
  maxCodeBytes: number;
  maxRequestBytes: number;
  maxToolResultBytes: number;
  maxResultBytes: number;
  maxLogBytes: number;
  maxToolCalls: number;
  maxDiscoveryRequests: number;
  maxPendingRequests: number;
  maxConcurrentCalls: number;
  maxConcurrentExecutions: number;
  approvalTimeoutMs: number;
  maxApprovalArgumentsChars: number;
}

/*
 * Operator-owned trust rules. Nothing here comes from scripts, models or
 * upstream servers: a tool skips per-call approval only when the gateway
 * defined it as read-only, an exact name pattern lists it, or the operator
 * trusts that server's readOnlyHint annotations.
 */
export interface CodeModeTrustPolicy {
  trustedReadTools: string[];
  trustedAnnotationServers: string[];
}

export interface CodeModeConfig {
  enabled: boolean;
  requireToolApproval: boolean;
  runnerPath?: string;
  limits: CodeModeLimits;
  trust: CodeModeTrustPolicy;
}

export const DEFAULT_CODE_MODE_LIMITS: CodeModeLimits = {
  cpuMs: 5_000,
  wallMs: 300_000,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 256 * 1024,
  runnerHeapMb: 64,
  maxCodeBytes: 64 * 1024,
  maxRequestBytes: 256 * 1024,
  maxToolResultBytes: 1024 * 1024,
  maxResultBytes: 256 * 1024,
  maxLogBytes: 32 * 1024,
  maxToolCalls: 50,
  maxDiscoveryRequests: 100,
  maxPendingRequests: 64,
  maxConcurrentCalls: 4,
  maxConcurrentExecutions: 4,
  approvalTimeoutMs: 120_000,
  maxApprovalArgumentsChars: 8_000,
};

export type CallClassification =
  | {
      kind: "trusted-read";
      reason: "built-in-read-only" | "trusted-tool" | "trusted-annotations";
    }
  | { kind: "approval-required" };

export function classifyToolCall(props: {
  name: string;
  serverName: string;
  origin: string;
  definition: Tool;
  trust: CodeModeTrustPolicy;
}): CallClassification {
  const { name, serverName, origin, definition, trust } = props;
  const annotations = definition.annotations;
  const declaresReadOnly =
    annotations?.readOnlyHint === true && annotations.destructiveHint !== true;
  // built-in definitions are authored by the gateway, not by an upstream
  if (origin === "internal" && declaresReadOnly) {
    return { kind: "trusted-read", reason: "built-in-read-only" };
  }
  if (trust.trustedReadTools.some((pattern) => matchesPattern(pattern, name))) {
    return { kind: "trusted-read", reason: "trusted-tool" };
  }
  if (
    origin !== "internal" &&
    declaresReadOnly &&
    trust.trustedAnnotationServers.some((pattern) =>
      matchesPattern(pattern, serverName),
    )
  ) {
    return { kind: "trusted-read", reason: "trusted-annotations" };
  }
  return { kind: "approval-required" };
}

export type ReadOnlyDecision =
  | Extract<CallClassification, { kind: "trusted-read" }>
  | { kind: "blocked"; reason: "declares-write" | "not-trusted" };

/*
 * mcpx_execute_readonly runs a call only when the trust policy above, limited
 * to exact entries, classifies it as a trusted read. A `*` pattern also
 * matches tools and servers added later, so it does not count here.
 * Annotations can only narrow the result: a definition that declares a write
 * (readOnlyHint false or destructiveHint true) is refused even when its exact
 * name is listed.
 */
export function classifyReadOnlyCall(
  props: Parameters<typeof classifyToolCall>[0],
): ReadOnlyDecision {
  const annotations = props.definition.annotations;
  if (
    annotations?.readOnlyHint === false ||
    annotations?.destructiveHint === true
  ) {
    return { kind: "blocked", reason: "declares-write" };
  }
  const exact = (patterns: string[]): string[] =>
    patterns.filter((pattern) => !pattern.includes("*"));
  const classification = classifyToolCall({
    ...props,
    trust: {
      trustedReadTools: exact(props.trust.trustedReadTools),
      trustedAnnotationServers: exact(props.trust.trustedAnnotationServers),
    },
  });
  return classification.kind === "trusted-read"
    ? classification
    : { kind: "blocked", reason: "not-trusted" };
}

/*
 * Whether mcpx_execute_readonly would run a visible tool now, as reported by
 * discovery: the same reserved names and classifyReadOnlyCall that execution
 * applies. `unavailable` means the gateway cannot run read-only scripts.
 * Discovery only informs; every call is classified again when it runs.
 */
export type ReadOnlyEligibility =
  | { eligible: true }
  | {
      eligible: false;
      reason: "declares_write" | "not_trusted" | "reserved" | "unavailable";
    };

export function readOnlyEligibility(
  props: Parameters<typeof classifyToolCall>[0],
): ReadOnlyEligibility {
  if (CODE_MODE_RESERVED_TOOL_NAMES.has(props.name)) {
    return { eligible: false, reason: "reserved" };
  }
  const decision = classifyReadOnlyCall(props);
  if (decision.kind === "trusted-read") return { eligible: true };
  return {
    eligible: false,
    reason:
      decision.reason === "declares-write" ? "declares_write" : "not_trusted",
  };
}

// Anchored match where `*` is the only wildcard; every other character is literal.
export function matchesPattern(pattern: string, value: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(value);
}
