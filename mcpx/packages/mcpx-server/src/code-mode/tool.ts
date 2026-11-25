import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CodeModeLimits } from "./policy.js";

export const CODE_MODE_TOOL_NAME = "mcpx_execute";
export const CODE_MODE_READONLY_TOOL_NAME = "mcpx_execute_readonly";

// Gateway meta-tools that scripts must not reach through mcpx.callTool.
export const CODE_MODE_RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([
  CODE_MODE_TOOL_NAME,
  CODE_MODE_READONLY_TOOL_NAME,
  "mcpx_list_servers",
  "mcpx_search_tools",
  "mcpx_get_tool_schema",
  "mcpx_call_tool",
]);

const SCRIPT_INTERFACE = [
  "`code` is the body of an async function: use await and return a JSON-serializable value.",
  "Use await mcpx.listServers(), await mcpx.searchTools(query, { limit, offset, readOnly }), and await mcpx.getToolSchema(name, { format }) to discover tools.",
  'With { format: "compact" }, getToolSchema returns an informational TypeScript-like inputType instead of the full schema; when its complete field is false, get the full schema for exact constraints.',
  "Search results include readOnlyEligibility. Set readOnly to true to find only tools eligible for mcpx_execute_readonly.",
  "await mcpx.callTool(name, args) returns { isError, content, structuredContent, text, data }. The data field contains structuredContent or parsed JSON text.",
  "mcpx.describe(value) returns a bounded description of its types, keys, and array lengths.",
  "console.log output is returned. There is no filesystem, network, timer or module access.",
  "Every inner call uses your normal MCPX permissions and audit.",
];

const scriptLimits = (limits: CodeModeLimits): string =>
  `Limits: ${limits.maxToolCalls} tool calls, ${limits.cpuMs} ms CPU, ${Math.round(limits.wallMs / 1000)} s total.`;

const inputSchema = (limits: CodeModeLimits): Tool["inputSchema"] => ({
  type: "object",
  properties: {
    code: {
      type: "string",
      minLength: 1,
      maxLength: limits.maxCodeBytes,
      description: "Async function body in JavaScript.",
    },
  },
  required: ["code"],
  additionalProperties: false,
});

export function buildCodeModeTool(
  limits: CodeModeLimits,
  requireToolApproval: boolean,
): Tool {
  return {
    name: CODE_MODE_TOOL_NAME,
    description: [
      "Run JavaScript in an isolated MCPX sandbox to chain and filter tool calls server-side, so only the final value returns to you.",
      ...SCRIPT_INTERFACE,
      "A gateway failure (not visible, denied, approval missing) rejects with an Error whose code says why.",
      requireToolApproval
        ? "This gateway asks the user to approve each call that is not a trusted read, including its exact arguments."
        : "The client controls approval for mcpx_execute; the gateway adds no separate prompt for its inner calls.",
      scriptLimits(limits),
      "MCPX never retries a call or script: after a failure, read the calls report before retrying anything.",
    ].join(" "),
    inputSchema: inputSchema(limits),
    annotations: {
      title: "Execute MCPX code",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  };
}

export function buildCodeModeReadOnlyTool(limits: CodeModeLimits): Tool {
  return {
    name: CODE_MODE_READONLY_TOOL_NAME,
    description: [
      "Run JavaScript in the same isolated MCPX sandbox as mcpx_execute, limited to reads the gateway trusts.",
      "Inner calls run only for built-in read-only MCPX tools and for tools the gateway operator trusts as reads.",
      "Every other call, including tools with unknown side effects or a write annotation, is refused before it runs with code read_only_blocked; an upstream readOnlyHint alone does not make a tool trusted.",
      "The gateway checks eligibility again on each call. The gateway asks for no approval inside this tool.",
      ...SCRIPT_INTERFACE,
      "A gateway failure (not visible, denied, read_only_blocked) rejects with an Error whose code says why.",
      scriptLimits(limits),
      "Use mcpx_execute or a direct call for anything else.",
    ].join(" "),
    inputSchema: inputSchema(limits),
    annotations: {
      title: "Execute MCPX code (trusted reads only)",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  };
}

export const CODE_MODE_INSTRUCTIONS =
  "Use direct tool calls for a single small lookup. For a chain of calls or a large response you can filter, use mcpx_execute. It runs JavaScript on MCPX so you can inspect full schemas and intermediate results inside the script and return just what you need. For read-only work of this kind, use mcpx_execute_readonly and find eligible tools with mcpx.searchTools(query, { readOnly: true }). MCPX checks permissions on every inner call.";

export const CATALOG_INSTRUCTIONS = `MCPX is a gateway to multiple MCP servers; their tools are listed with server-prefixed names. ${CODE_MODE_INSTRUCTIONS}`;
