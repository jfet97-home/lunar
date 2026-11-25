import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { CodeModeLimits } from "./policy.js";

export const CODE_MODE_TOOL_NAME = "mcpx_execute";

// Gateway meta-tools that scripts must not reach through mcpx.callTool.
export const CODE_MODE_RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([
  CODE_MODE_TOOL_NAME,
  "mcpx_list_servers",
  "mcpx_search_tools",
  "mcpx_get_tool_schema",
  "mcpx_call_tool",
]);

export function buildCodeModeTool(
  limits: CodeModeLimits,
  requireToolApproval: boolean,
): Tool {
  return {
    name: CODE_MODE_TOOL_NAME,
    description: [
      "Run JavaScript in an isolated MCPX sandbox to chain and filter tool calls server-side, so only the final value returns to you.",
      "`code` is the body of an async function: use await and return a JSON-serializable value.",
      "Inside it: await mcpx.listServers(); await mcpx.searchTools(query, { limit, offset }); await mcpx.getToolSchema(name); await mcpx.callTool(name, args) returns { isError, content, structuredContent, text, data }, where data is structuredContent or parsed JSON text.",
      "A gateway failure (not visible, denied, approval missing) rejects with an Error whose code says why. console.log output is returned.",
      "There is no filesystem, network, timer or module access.",
      "Every inner call uses your normal MCPX permissions and audit.",
      requireToolApproval
        ? "This gateway asks the user to approve each call that is not a trusted read, including its exact arguments."
        : "The client controls approval for mcpx_execute; the gateway adds no separate prompt for its inner calls.",
      `Limits: ${limits.maxToolCalls} tool calls, ${limits.cpuMs} ms CPU, ${Math.round(limits.wallMs / 1000)} s total.`,
      "MCPX never retries a call or script: after a failure, read the calls report before retrying anything.",
    ].join(" "),
    inputSchema: {
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
    },
    annotations: {
      title: "Execute MCPX code",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  };
}

export const CODE_MODE_INSTRUCTIONS =
  "For multi-step work, mcpx_execute runs JavaScript server-side that discovers, chains and filters MCPX tool calls and returns only the final value; prefer it over many separate calls when intermediate results are large. Inner calls keep your permissions and are subject to the gateway's tool approval policy.";

export const CATALOG_INSTRUCTIONS = `MCPX is a gateway to multiple MCP servers; their tools are listed with server-prefixed names. ${CODE_MODE_INSTRUCTIONS}`;
