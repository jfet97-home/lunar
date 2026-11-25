import {
  ClientCapabilities,
  ElicitRequest,
  ElicitResultSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

export interface ApprovalRequest {
  callIndex: number;
  toolName: string;
  serverName: string;
  arguments: Record<string, unknown>;
}

export type ApprovalDenialCode =
  | "approval_unsupported"
  | "approval_declined"
  | "approval_cancelled"
  | "approval_timeout"
  | "approval_failed"
  | "approval_too_large";

export type ApprovalDecision =
  | { approved: true }
  | { approved: false; code: ApprovalDenialCode; message: string };

export type ApprovalRequester = (props: {
  request: ApprovalRequest;
  signal: AbortSignal;
  timeoutMs: number;
}) => Promise<ApprovalDecision>;

type SendElicitation = (props: {
  params: ElicitRequest["params"];
  signal: AbortSignal;
  timeoutMs: number;
}) => Promise<unknown>;

export function supportsFormElicitation(
  capabilities: ClientCapabilities | undefined,
): boolean {
  // the SDK normalizes a bare `elicitation: {}` to form support
  return capabilities?.elicitation?.form !== undefined;
}

/*
 * Asks the human through MCP form elicitation, as a request related to the
 * outer mcpx_execute call. Each call gets its own request, so an answer
 * covers exactly one call with the arguments displayed; nothing is cached or
 * reusable, and the script can neither see nor answer the request.
 */
export function createElicitationApprover(props: {
  supported: () => boolean;
  send: SendElicitation;
  maxArgumentsChars: number;
}): ApprovalRequester {
  const { supported, send, maxArgumentsChars } = props;
  return async ({ request, signal, timeoutMs }) => {
    if (!supported()) {
      return {
        approved: false,
        code: "approval_unsupported",
        message:
          "This call needs user approval, but the MCP client does not support form elicitation. Call the tool directly so the client can ask for approval.",
      };
    }
    const argumentsText = JSON.stringify(request.arguments, null, 2);
    if (argumentsText.length > maxArgumentsChars) {
      return {
        approved: false,
        code: "approval_too_large",
        message: `The arguments are too large to show for approval (${argumentsText.length} characters, limit ${maxArgumentsChars}). Call the tool directly instead.`,
      };
    }
    let response: unknown;
    try {
      response = await send({
        params: {
          message: approvalMessage(request, argumentsText),
          requestedSchema: {
            type: "object",
            properties: {
              approve: {
                type: "boolean",
                title: "Approve this exact call",
                description: `Run ${request.toolName} once with the arguments shown.`,
              },
            },
            required: ["approve"],
          },
        },
        signal,
        timeoutMs,
      });
    } catch (error) {
      if (signal.aborted) {
        return {
          approved: false,
          code: "approval_cancelled",
          message: "The script stopped before the approval completed.",
        };
      }
      if (
        error instanceof McpError &&
        error.code === ErrorCode.RequestTimeout
      ) {
        return {
          approved: false,
          code: "approval_timeout",
          message: "No approval answer arrived in time; the call did not run.",
        };
      }
      return {
        approved: false,
        code: "approval_failed",
        message: `The approval request failed; the call did not run: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const parsed = ElicitResultSchema.safeParse(response);
    if (!parsed.success) {
      return {
        approved: false,
        code: "approval_failed",
        message: "The client returned an invalid approval answer.",
      };
    }
    const { action, content } = parsed.data;
    if (action === "accept" && content?.["approve"] === true) {
      return { approved: true };
    }
    if (action === "cancel") {
      return {
        approved: false,
        code: "approval_cancelled",
        message: "The user dismissed the approval; the call did not run.",
      };
    }
    return {
      approved: false,
      code: "approval_declined",
      message: "The user did not approve this call; it did not run.",
    };
  };
}

function approvalMessage(
  request: ApprovalRequest,
  argumentsText: string,
): string {
  return [
    "MCPX Code Mode needs your approval before running a tool call that may change data.",
    "",
    `Tool: ${request.toolName}`,
    `Server: ${request.serverName}`,
    `Script call: #${request.callIndex}`,
    "",
    "Exact arguments that will be sent:",
    argumentsText,
    "",
    "Approve only if you intend this exact call. The approval covers this one call and these arguments only.",
  ].join("\n");
}
