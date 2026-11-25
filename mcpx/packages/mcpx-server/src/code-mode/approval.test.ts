import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  ApprovalRequest,
  createElicitationApprover,
  supportsFormElicitation,
} from "./approval.js";

const request: ApprovalRequest = {
  callIndex: 2,
  toolName: "tracker__create_issue",
  serverName: "tracker",
  arguments: { title: "Ship it", labels: ["a"] },
};

function approver(
  send: jest.Mock,
  options: { supported?: boolean; maxArgumentsChars?: number } = {},
): ReturnType<typeof createElicitationApprover> {
  return createElicitationApprover({
    supported: () => options.supported ?? true,
    send,
    maxArgumentsChars: options.maxArgumentsChars ?? 8000,
  });
}

async function decide(
  send: jest.Mock,
  options: { supported?: boolean; maxArgumentsChars?: number } = {},
  signal = new AbortController().signal,
): Promise<Awaited<ReturnType<ReturnType<typeof createElicitationApprover>>>> {
  return approver(send, options)({ request, signal, timeoutMs: 1000 });
}

describe("Code Mode elicitation approval", () => {
  it("detects form elicitation support", () => {
    expect(supportsFormElicitation({ elicitation: { form: {} } })).toBe(true);
    expect(supportsFormElicitation({ elicitation: { url: {} } })).toBe(false);
    expect(supportsFormElicitation({})).toBe(false);
    expect(supportsFormElicitation(undefined)).toBe(false);
  });

  it("fails closed without asking when the client cannot elicit", async () => {
    const send = jest.fn();
    await expect(decide(send, { supported: false })).resolves.toMatchObject({
      approved: false,
      code: "approval_unsupported",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("shows the exact tool and arguments and requires an explicit yes", async () => {
    const send = jest.fn(async () => ({
      action: "accept",
      content: { approve: true },
    }));
    await expect(decide(send)).resolves.toEqual({ approved: true });
    expect(send).toHaveBeenCalledTimes(1);
    const [{ params, timeoutMs }] = send.mock.calls[0] as unknown as [
      {
        params: {
          message: string;
          requestedSchema: {
            properties: Record<string, Record<string, unknown>>;
            required: string[];
          };
        };
        timeoutMs: number;
      },
    ];
    expect(timeoutMs).toBe(1000);
    expect(params.message).toContain("Tool: tracker__create_issue");
    expect(params.message).toContain("Server: tracker");
    expect(params.message).toContain(
      JSON.stringify(request.arguments, null, 2),
    );
    expect(params.requestedSchema.required).toEqual(["approve"]);
    expect(params.requestedSchema.properties["approve"]).toMatchObject({
      type: "boolean",
    });
    // a client applying defaults must never pre-approve
    expect(params.requestedSchema.properties["approve"]).not.toHaveProperty(
      "default",
    );
  });

  it.each([
    [{ action: "accept", content: { approve: false } }, "approval_declined"],
    [{ action: "accept" }, "approval_declined"],
    [{ action: "accept", content: { approve: "true" } }, "approval_declined"],
    [{ action: "decline" }, "approval_declined"],
    [{ action: "cancel" }, "approval_cancelled"],
    [{ action: "maybe" }, "approval_failed"],
  ])("treats %j as no approval", async (response, code) => {
    await expect(decide(jest.fn(async () => response))).resolves.toMatchObject({
      approved: false,
      code,
    });
  });

  it("maps timeouts, aborts and transport errors to fail-closed outcomes", async () => {
    await expect(
      decide(
        jest.fn(async () => {
          throw new McpError(ErrorCode.RequestTimeout, "timed out");
        }),
      ),
    ).resolves.toMatchObject({ approved: false, code: "approval_timeout" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      decide(
        jest.fn(async () => {
          throw new Error("aborted");
        }),
        {},
        controller.signal,
      ),
    ).resolves.toMatchObject({ approved: false, code: "approval_cancelled" });
    await expect(
      decide(
        jest.fn(async () => {
          throw new Error("Method not found");
        }),
      ),
    ).resolves.toMatchObject({ approved: false, code: "approval_failed" });
  });

  it("refuses to ask about arguments it cannot show in full", async () => {
    const send = jest.fn();
    await expect(
      decide(send, { maxArgumentsChars: 10 }),
    ).resolves.toMatchObject({ approved: false, code: "approval_too_large" });
    expect(send).not.toHaveBeenCalled();
  });
});
