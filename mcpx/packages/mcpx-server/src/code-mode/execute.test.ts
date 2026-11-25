import path from "node:path";
import { noOpLogger } from "@aigw/core/logging";
import { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ApprovalRequester } from "./approval.js";
import {
  CodeModeGateway,
  DispatchOutcome,
  executeCode,
  ResolvedCall,
} from "./execute.js";
import { CodeModeLimits, DEFAULT_CODE_MODE_LIMITS } from "./policy.js";

const RUNNER_PATH = path.resolve(process.cwd(), "src/code-mode/runner.ts");

interface FakeTool {
  serverName?: string;
  origin?: "upstream" | "internal";
  annotations?: Tool["annotations"];
  reject?: Extract<ResolvedCall, { ok: false }>["code"];
  run?: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

interface Execution {
  output: {
    ok: boolean;
    result?: unknown;
    error?: { code: string; message: string };
    calls: Record<string, unknown>[];
    logs?: string[];
    note?: string;
    callsOverLimit?: number;
  };
  isError: boolean;
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function makeGateway(
  tools: Record<string, FakeTool>,
  overrides: Partial<CodeModeGateway> = {},
): CodeModeGateway & { dispatched: [string, Record<string, unknown>][] } {
  const dispatched: [string, Record<string, unknown>][] = [];
  const resolve = (name: string): ResolvedCall => {
    const tool = tools[name];
    if (!tool) return { ok: false, code: "not_available", message: "nope" };
    if (tool.reject) return { ok: false, code: tool.reject, message: "no" };
    return {
      ok: true,
      serverName: tool.serverName ?? name.split("__")[0] ?? "",
      origin: tool.origin ?? "upstream",
      definition: {
        name,
        inputSchema: { type: "object" },
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      },
      binding: `binding:${name}`,
    };
  };
  return {
    dispatched,
    discover: async (tool, args) =>
      textResult(JSON.stringify({ tool, args, tools: Object.keys(tools) })),
    resolve,
    dispatch: async (name, args, binding): Promise<DispatchOutcome> => {
      const resolved = resolve(name);
      if (!resolved.ok) return { kind: "rejected", ...resolved };
      if (resolved.binding !== binding) {
        return { kind: "rejected", code: "target_changed", message: "x" };
      }
      dispatched.push([name, args]);
      const run = tools[name]?.run ?? (async () => textResult("done"));
      return { kind: "result", result: await run(args) };
    },
    ...overrides,
  };
}

const approveAll: ApprovalRequester = async () => ({ approved: true });

async function execute(props: {
  code: string;
  gateway: CodeModeGateway;
  approve?: ApprovalRequester;
  limits?: Partial<CodeModeLimits>;
  trustedReadTools?: string[];
  signal?: AbortSignal;
}): Promise<Execution> {
  const result = await executeCode({
    code: props.code,
    runnerPath: RUNNER_PATH,
    limits: {
      ...DEFAULT_CODE_MODE_LIMITS,
      cpuMs: 2_000,
      wallMs: 15_000,
      ...props.limits,
    },
    trust: {
      trustedReadTools: props.trustedReadTools ?? [],
      trustedAnnotationServers: [],
    },
    gateway: props.gateway,
    approve: props.approve ?? approveAll,
    signal: props.signal,
    logger: noOpLogger,
    executionId: "test",
  });
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("Expected text output");
  return {
    output: JSON.parse(block.text) as Execution["output"],
    isError: result.isError === true,
  };
}

describe("Code Mode execution", () => {
  jest.setTimeout(30_000);

  it("chains discovery and trusted reads server-side and returns only the filtered value", async () => {
    const gateway = makeGateway({
      docs__search: {
        run: async ({ query }) =>
          textResult(
            JSON.stringify([
              { id: "a", title: `${String(query)} one`, size: 10 },
              { id: "b", title: `${String(query)} two`, size: 900 },
            ]),
          ),
      },
      docs__get_page: {
        run: async ({ id }) => ({
          content: [{ type: "text", text: `body of ${String(id)}` }],
          structuredContent: { id, words: 3 },
        }),
      },
      docs__plain: { run: async () => textResult("not json") },
    });
    const { output, isError } = await execute({
      gateway,
      trustedReadTools: ["docs__*"],
      code: `
        const servers = await mcpx.listServers();
        const found = await mcpx.searchTools("docs");
        const schema = await mcpx.getToolSchema("docs__get_page");
        const hits = (await mcpx.callTool("docs__search", { query: "guide" })).data;
        const small = hits.filter((hit) => hit.size < 100);
        const pages = await Promise.all(small.map((hit) => mcpx.callTool("docs__get_page", { id: hit.id })));
        const plain = await mcpx.callTool("docs__plain", {});
        return {
          discovered: [servers.tool, found.args, schema.args],
          pages: pages.map((page) => ({ text: page.text, data: page.data, isError: page.isError })),
          plain: { text: plain.text, data: plain.data ?? null },
        };
      `,
    });
    expect(isError).toBe(false);
    expect(output.result).toEqual({
      discovered: [
        "mcpx_list_servers",
        { query: "docs" },
        { name: "docs__get_page" },
      ],
      pages: [
        { text: "body of a", data: { id: "a", words: 3 }, isError: false },
      ],
      plain: { text: "not json", data: null },
    });
    expect(output.calls).toEqual([
      expect.objectContaining({
        index: 1,
        tool: "docs__search",
        status: "succeeded",
        approval: "trusted_read",
      }),
      expect.objectContaining({
        index: 2,
        tool: "docs__get_page",
        status: "succeeded",
        approval: "trusted_read",
      }),
      expect.objectContaining({
        index: 3,
        tool: "docs__plain",
        status: "succeeded",
        approval: "trusted_read",
      }),
    ]);
  });

  it("asks once per call for untrusted tools and dispatches exactly the approved arguments", async () => {
    const gateway = makeGateway({ tracker__create: {} });
    const asked: unknown[] = [];
    const approve: ApprovalRequester = async ({ request }) => {
      asked.push(request.arguments);
      return asked.length === 1
        ? { approved: true }
        : { approved: false, code: "approval_declined", message: "no" };
    };
    const { output } = await execute({
      gateway,
      approve,
      code: `
        const args = { title: "first", tags: ["a"] };
        const pending = mcpx.callTool("tracker__create", args);
        args.title = "mutated after the call";
        const first = await pending;
        let second;
        try {
          await mcpx.callTool("tracker__create", { title: "first", tags: ["a"] });
        } catch (error) {
          second = error.code;
        }
        return { first: first.text, second };
      `,
    });
    expect(output.result).toEqual({
      first: "done",
      second: "approval_declined",
    });
    expect(asked).toEqual([
      { title: "first", tags: ["a"] },
      { title: "first", tags: ["a"] },
    ]);
    expect(gateway.dispatched).toEqual([
      ["tracker__create", { title: "first", tags: ["a"] }],
    ]);
    expect(output.calls).toEqual([
      expect.objectContaining({
        status: "succeeded",
        approval: "user_approved",
      }),
      expect.objectContaining({
        status: "declined",
        errorCode: "approval_declined",
      }),
    ]);
  });

  it("shows one approval prompt at a time even for parallel writes", async () => {
    const gateway = makeGateway({ tracker__create: {} });
    let open = 0;
    let peak = 0;
    const approve: ApprovalRequester = async () => {
      open += 1;
      peak = Math.max(peak, open);
      await new Promise((resolve) => setTimeout(resolve, 30));
      open -= 1;
      return { approved: true };
    };
    const { output } = await execute({
      gateway,
      approve,
      code: `
        await Promise.all([1, 2, 3].map((n) => mcpx.callTool("tracker__create", { n })));
        return "ok";
      `,
    });
    expect(output.result).toBe("ok");
    expect(peak).toBe(1);
    expect(gateway.dispatched).toHaveLength(3);
  });

  it("does not trust upstream read-only annotations without operator policy", async () => {
    const gateway = makeGateway({
      wiki__read: { annotations: { readOnlyHint: true } },
    });
    const approve = jest.fn<
      ReturnType<ApprovalRequester>,
      Parameters<ApprovalRequester>
    >(async () => ({
      approved: false,
      code: "approval_unsupported",
      message: "unsupported",
    }));
    const { output } = await execute({
      gateway,
      approve,
      code: `try { await mcpx.callTool("wiki__read", {}); } catch (error) { return error.code; }`,
    });
    expect(output.result).toBe("approval_unsupported");
    expect(approve).toHaveBeenCalledTimes(1);
    expect(gateway.dispatched).toEqual([]);
  });

  it("rejects hidden, denied and wrapper tools before any dispatch", async () => {
    const gateway = makeGateway({
      secrets__read: { reject: "permission_denied" },
      legacy__fetch: { reject: "server_inactive" },
    });
    const approve = jest.fn(approveAll);
    const { output } = await execute({
      gateway,
      approve,
      code: `
        const codes = [];
        for (const name of ["secrets__read", "legacy__fetch", "hidden__tool", "mcpx_execute", "mcpx_call_tool"]) {
          try { await mcpx.callTool(name, {}); } catch (error) { codes.push(error.code); }
        }
        try { await mcpx.callTool("tracker__create", [1, 2]); } catch (error) { codes.push(error.code); }
        return codes;
      `,
    });
    expect(output.result).toEqual([
      "permission_denied",
      "server_inactive",
      "not_available",
      "recursion_blocked",
      "recursion_blocked",
      "invalid_arguments",
    ]);
    expect(approve).not.toHaveBeenCalled();
    expect(gateway.dispatched).toEqual([]);
  });

  it("never dispatches when the approved target changed before dispatch", async () => {
    const gateway = makeGateway({ tracker__create: {} });
    gateway.dispatch = async () => ({
      kind: "rejected",
      code: "target_changed",
      message: "changed",
    });
    const { output } = await execute({
      gateway,
      code: `try { await mcpx.callTool("tracker__create", {}); } catch (error) { return error.code; }`,
    });
    expect(output.result).toBe("target_changed");
    expect(output.calls).toEqual([
      expect.objectContaining({
        status: "rejected",
        errorCode: "target_changed",
      }),
    ]);
  });

  it("enforces the tool-call budget and the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const gateway = makeGateway({
      docs__slow: {
        run: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 50));
          inFlight -= 1;
          return textResult("ok");
        },
      },
    });
    const { output } = await execute({
      gateway,
      trustedReadTools: ["docs__slow"],
      limits: { maxToolCalls: 5, maxConcurrentCalls: 2 },
      code: `
        const results = await Promise.allSettled(
          Array.from({ length: 7 }, () => mcpx.callTool("docs__slow", {})),
        );
        return results.map((result) => result.status === "fulfilled" ? "ok" : result.reason.code);
      `,
    });
    expect(output.result).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "call_limit",
      "call_limit",
    ]);
    expect(peak).toBe(2);
    expect(output.callsOverLimit).toBe(2);
    expect(gateway.dispatched).toHaveLength(5);
  });

  it("bounds discovery bursts and starts no queued discovery after cancellation", async () => {
    const controller = new AbortController();
    let started = 0;
    const gateway = makeGateway(
      {},
      {
        discover: () => {
          started += 1;
          if (started === 2) setTimeout(() => controller.abort(), 300);
          return new Promise<CallToolResult>(() => {});
        },
      },
    );
    const { output } = await execute({
      gateway,
      signal: controller.signal,
      limits: { maxConcurrentCalls: 2, maxPendingRequests: 10 },
      code: `
        const first = mcpx.searchTools("first");
        for (let i = 0; i < 40; i++) {
          mcpx.searchTools("q" + i).catch((error) => console.log(error.code));
        }
        await first;
      `,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(output.error?.code).toBe("cancelled");
    expect(started).toBe(2);
    expect(output.logs).toEqual(
      Array.from({ length: 31 }, () => "too_many_pending_requests"),
    );
  });

  it("caps discovery requests and discovery reply size", async () => {
    const gateway = makeGateway(
      {},
      { discover: async () => textResult(JSON.stringify("x".repeat(2_000))) },
    );
    const { output } = await execute({
      gateway,
      limits: { maxDiscoveryRequests: 2, maxToolResultBytes: 1_000 },
      code: `
        const codes = [];
        for (let i = 0; i < 3; i++) {
          try { await mcpx.listServers(); } catch (error) { codes.push(error.code); }
        }
        return codes;
      `,
    });
    expect(output.result).toEqual([
      "result_too_large",
      "result_too_large",
      "discovery_limit",
    ]);
  });

  it("reports an ambiguous failure once without retrying the call or the script", async () => {
    const run = jest.fn(async (): Promise<CallToolResult> => {
      throw new Error("Connection closed");
    });
    const gateway = makeGateway({ tracker__create: { run } });
    const { output, isError } = await execute({
      gateway,
      code: `
        try {
          await mcpx.callTool("tracker__create", { title: "x" });
        } catch (error) {
          return { code: error.code, message: error.message };
        }
      `,
    });
    expect(isError).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(output.result).toEqual({
      code: "call_failed",
      message: expect.stringContaining("outcome is unknown"),
    });
    expect(output.calls).toEqual([
      expect.objectContaining({ status: "failed", outcome: "unknown" }),
    ]);
  });

  it("reports completed calls when the script fails afterwards", async () => {
    const gateway = makeGateway({ tracker__create: {} });
    const { output, isError } = await execute({
      gateway,
      code: `
        await mcpx.callTool("tracker__create", { n: 1 });
        await mcpx.callTool("tracker__create", { n: 2 });
        throw new Error("boom");
      `,
    });
    expect(isError).toBe(true);
    expect(output.error).toEqual({
      code: "script_error",
      message: "Error: boom",
    });
    expect(output.calls.map((call) => call["status"])).toEqual([
      "succeeded",
      "succeeded",
    ]);
    expect(output.note).toContain("never retries");
    expect(gateway.dispatched).toHaveLength(2);
  });

  it("stops scheduling on cancellation and reports the in-flight call as unknown", async () => {
    const controller = new AbortController();
    const gateway = makeGateway({
      tracker__create: {
        run: () => {
          setTimeout(() => controller.abort(), 50);
          return new Promise<CallToolResult>(() => {});
        },
      },
      tracker__next: {},
    });
    const { output } = await execute({
      gateway,
      signal: controller.signal,
      code: `
        await mcpx.callTool("tracker__create", {});
        await mcpx.callTool("tracker__next", {});
      `,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(output.error?.code).toBe("cancelled");
    expect(output.calls).toEqual([
      expect.objectContaining({
        tool: "tracker__create",
        status: "in_flight",
        outcome: "unknown",
      }),
    ]);
    expect(gateway.dispatched.map(([name]) => name)).toEqual([
      "tracker__create",
    ]);
  });

  it("withholds oversized results and says the call already completed", async () => {
    const gateway = makeGateway({
      docs__dump: { run: async () => textResult("x".repeat(5_000)) },
    });
    const { output } = await execute({
      gateway,
      trustedReadTools: ["docs__dump"],
      limits: { maxToolResultBytes: 1_000 },
      code: `try { await mcpx.callTool("docs__dump", {}); } catch (error) { return error.code; }`,
    });
    expect(output.result).toBe("result_too_large");
    expect(output.calls).toEqual([
      expect.objectContaining({ status: "succeeded", resultWithheld: true }),
    ]);
  });

  it("stops at the wall-time limit while waiting for approval", async () => {
    const gateway = makeGateway({ tracker__create: {} });
    const timeouts: number[] = [];
    const approve: ApprovalRequester = ({ timeoutMs, signal }) => {
      timeouts.push(timeoutMs);
      return new Promise((resolve) =>
        signal.addEventListener("abort", () =>
          resolve({
            approved: false,
            code: "approval_cancelled",
            message: "stopped",
          }),
        ),
      );
    };
    const { output } = await execute({
      gateway,
      approve,
      limits: { wallMs: 800, approvalTimeoutMs: 60_000 },
      code: `await mcpx.callTool("tracker__create", {});`,
    });
    expect(output.error?.code).toBe("wall_timeout");
    expect(timeouts[0]).toBeLessThanOrEqual(800);
    expect(output.calls).toEqual([
      expect.objectContaining({ status: "not_started" }),
    ]);
    expect(gateway.dispatched).toEqual([]);
  });
});
