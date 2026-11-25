import { fork } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildRunnerExecArgv,
  runSandbox,
  SandboxLimits,
  SandboxLog,
  SandboxOutcome,
  SandboxRequest,
} from "./sandbox.js";

// jest runs from the package directory; Node strips the runner's types
const RUNNER_PATH = path.resolve(process.cwd(), "src/code-mode/runner.ts");

const LIMITS: SandboxLimits = {
  cpuMs: 1_000,
  wallMs: 10_000,
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 256 * 1024,
  runnerHeapMb: 64,
  maxRequestBytes: 64 * 1024,
  maxPendingRequests: 64,
  maxLogBytes: 1024,
  maxResultBytes: 64 * 1024,
};

async function run(
  code: string,
  options: {
    limits?: Partial<SandboxLimits>;
    signal?: AbortSignal;
    onRequest?: (
      request: SandboxRequest,
      stopped: AbortSignal,
    ) => Promise<string>;
  } = {},
): Promise<{ outcome: SandboxOutcome; logs: SandboxLog[] }> {
  const logs: SandboxLog[] = [];
  const outcome = await runSandbox({
    runnerPath: RUNNER_PATH,
    code,
    limits: { ...LIMITS, ...options.limits },
    signal: options.signal,
    onRequest:
      options.onRequest ??
      (async (request) =>
        JSON.stringify({
          ok: true,
          value: { op: request.op, payload: JSON.parse(request.payload) },
        })),
    onLog: (log) => logs.push(log),
  });
  return { outcome, logs };
}

describe("Code Mode sandbox runner", () => {
  jest.setTimeout(30_000);

  it("brokers structured requests and returns the script's JSON value", async () => {
    const { outcome, logs } = await run(`
      const [call, servers] = await Promise.all([
        mcpx.callTool("docs__get_page", { id: 7, nested: { ok: true } }),
        mcpx.listServers(),
      ]);
      const search = await mcpx.searchTools("pages", { limit: 2 });
      const schema = await mcpx.getToolSchema("docs__get_page");
      console.log("seen", call.op);
      console.warn({ count: 2 });
      return { call, servers, search, schema };
    `);
    expect(outcome).toEqual({
      status: "completed",
      result: JSON.stringify({
        call: {
          op: "call",
          payload: {
            name: "docs__get_page",
            arguments: { id: 7, nested: { ok: true } },
          },
          text: "",
        },
        servers: { op: "servers", payload: {} },
        search: { op: "search", payload: { limit: 2, query: "pages" } },
        schema: { op: "schema", payload: { name: "docs__get_page" } },
      }),
    });
    expect(logs).toEqual([
      { level: "log", text: "seen call" },
      { level: "warn", text: '{"count":2}' },
    ]);
  });

  it("rejects with the gateway error code when the broker refuses a request", async () => {
    const { outcome } = await run(
      `try {
         await mcpx.callTool("secrets__read", {});
       } catch (error) {
         return { name: error.name, code: error.code, message: error.message };
       }`,
      {
        onRequest: async () =>
          JSON.stringify({
            ok: false,
            error: { code: "permission_denied", message: "Permission denied" },
          }),
      },
    );
    expect(outcome).toEqual({
      status: "completed",
      result: JSON.stringify({
        name: "McpxError",
        code: "permission_denied",
        message: "Permission denied",
      }),
    });
  });

  it("gives scripts no host globals, modules, timers or escape hatches", async () => {
    const { outcome } = await run(`
      const probes = {
        process: typeof process,
        require: typeof require,
        fetch: typeof fetch,
        setTimeout: typeof setTimeout,
        WebAssembly: typeof WebAssembly,
        hostBridge: typeof globalThis.__mcpxHost,
        logBridge: typeof globalThis.__mcpxLog,
        functionEscape: typeof Function("return this")().process,
        constructorEscape: (() => {}).constructor("return typeof process")(),
      };
      try {
        await import("node:fs");
        probes.import = "loaded";
      } catch (error) {
        probes.import = String(error);
      }
      return probes;
    `);
    expect(outcome.status).toBe("completed");
    const probes = JSON.parse((outcome as { result: string }).result) as Record<
      string,
      string
    >;
    expect(probes).toMatchObject({
      process: "undefined",
      require: "undefined",
      fetch: "undefined",
      setTimeout: "undefined",
      WebAssembly: "undefined",
      hostBridge: "undefined",
      logBridge: "undefined",
      functionEscape: "undefined",
      constructorEscape: "undefined",
    });
    expect(probes["import"]).toMatch(/could not load module/);
  });

  it.each([
    ["CPU", "while (true) {}", "cpu"],
    [
      "memory",
      "const chunks = []; while (true) chunks.push('x'.repeat(1 << 20));",
      "memory",
    ],
    ["stack", "const f = () => f(); f();", "stack"],
    ["deadlock", "await new Promise(() => {});", "deadlock"],
    ["result", "return 'x'.repeat(70 * 1024);", "result"],
  ])(
    "stops a script that exceeds its %s limit",
    async (_label, code, reason) => {
      const { outcome } = await run(code);
      expect(outcome).toMatchObject({ status: "failed", error: { reason } });
    },
  );

  it("caps console output", async () => {
    const { outcome, logs } = await run(
      "for (let i = 0; i < 1000; i++) console.log('line ' + i); return 1;",
    );
    expect(outcome.status).toBe("completed");
    const total = logs.reduce(
      (sum, log) => sum + Buffer.byteLength(log.text),
      0,
    );
    expect(total).toBeLessThanOrEqual(LIMITS.maxLogBytes);
  });

  it("does not send empty console messages through the broker", async () => {
    const { outcome, logs } = await run(`
      for (let i = 0; i < 1000; i++) console.log();
      console.log("finished");
      return 1;
    `);
    expect(outcome.status).toBe("completed");
    expect(logs).toEqual([{ level: "log", text: "finished" }]);
  });

  it("limits outstanding requests before they enter the broker", async () => {
    const onRequest = jest.fn(async () => '{"ok":true,"value":1}');
    const { outcome } = await run(
      `return await Promise.all(Array.from({ length: 4 }, () =>
        mcpx.listServers().catch((error) => error.code),
      ));`,
      { limits: { maxPendingRequests: 2 }, onRequest },
    );
    expect(onRequest).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({
      status: "completed",
      result: '[1,1,"too_many_pending_requests","too_many_pending_requests"]',
    });
  });

  it("kills the runner at the wall-time limit and stops brokering", async () => {
    const stoppedSignals: AbortSignal[] = [];
    const startedAt = Date.now();
    const { outcome } = await run(
      "await mcpx.callTool('slow__wait', {}); return 'unreachable';",
      {
        limits: { wallMs: 500 },
        onRequest: (_request, stopped) => {
          stoppedSignals.push(stopped);
          return new Promise<string>(() => {});
        },
      },
    );
    expect(outcome).toEqual({ status: "timeout" });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(stoppedSignals).toHaveLength(1);
    expect(stoppedSignals[0]?.aborted).toBe(true);
  });

  it("stops on cancellation and never answers the script afterwards", async () => {
    const controller = new AbortController();
    const requests: string[] = [];
    const resultPromise = run(
      "for (let i = 0; i < 5; i++) await mcpx.callTool('t__step', { i }); return 'done';",
      {
        signal: controller.signal,
        onRequest: async (request) => {
          requests.push(request.payload);
          if (requests.length === 2) controller.abort();
          return JSON.stringify({ ok: true, value: {} });
        },
      },
    );
    const { outcome } = await resultPromise;
    expect(outcome).toEqual({ status: "cancelled" });
    expect(requests).toHaveLength(2);
  });
});

describe("Code Mode runner process permissions", () => {
  // the permission model compares real paths, and macOS links /var to /private/var
  const probeDirectory = realpathSync(
    mkdtempSync(path.join(tmpdir(), "mcpx-code-mode-")),
  );
  const probePath = path.join(probeDirectory, "probe.mjs");
  const secretPath = path.join(probeDirectory, "..", "mcpx-code-mode-secret");

  beforeAll(() => {
    writeFileSync(
      probePath,
      `
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
const attempt = (action) => {
  try { action(); return "allowed"; } catch (error) { return error.code ?? String(error); }
};
process.send({
  // macOS adds __CF_USER_TEXT_ENCODING to every process; it carries no secret
  env: Object.keys(process.env).filter((key) => key !== "__CF_USER_TEXT_ENCODING"),
  readRunner: attempt(() => readFileSync(${JSON.stringify(RUNNER_PATH)})),
  readOutside: attempt(() => readFileSync(${JSON.stringify(path.resolve(process.cwd(), "package.json"))})),
  write: attempt(() => writeFileSync(${JSON.stringify(secretPath)}, "x")),
  spawn: attempt(() => spawnSync(process.execPath, ["-v"])),
  worker: attempt(() => new Worker("1", { eval: true })),
  evalCode: attempt(() => new Function("return 1")()),
}, () => process.exit(0));
`,
    );
  });

  afterAll(() => {
    rmSync(probeDirectory, { recursive: true, force: true });
  });

  it("launches with the permission model, no writes and an empty environment", () => {
    const execArgv = buildRunnerExecArgv(RUNNER_PATH, 64);
    expect(execArgv).toContain("--permission");
    expect(execArgv).toContain("--disallow-code-generation-from-strings");
    const reads = execArgv
      .filter((flag) => flag.startsWith("--allow-fs-read="))
      .map((flag) => flag.slice("--allow-fs-read=".length));
    expect(reads).toContain(path.dirname(RUNNER_PATH));
    expect(reads.every((entry) => entry !== "*" && entry !== "/")).toBe(true);
    expect(
      execArgv.some((flag) =>
        /^--allow-(fs-write|child-process|worker|addons|wasi)/.test(flag),
      ),
    ).toBe(false);
  });

  it("denies host file, process and worker access to code in the runner process", async () => {
    process.env["MCPX_CODE_MODE_TEST_SECRET"] = "must-not-leak";
    const child = fork(probePath, [], {
      execArgv: [
        ...buildRunnerExecArgv(RUNNER_PATH, 64),
        `--allow-fs-read=${probeDirectory}`,
      ],
      env: {},
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const report = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        child.once("message", (message) =>
          resolve(message as Record<string, unknown>),
        );
        child.once("error", reject);
        child.once("exit", (code) =>
          reject(new Error(`Probe exited with code ${code}`)),
        );
      },
    ).finally(() => delete process.env["MCPX_CODE_MODE_TEST_SECRET"]);
    expect(report).toEqual({
      env: [],
      readRunner: "allowed",
      readOutside: "ERR_ACCESS_DENIED",
      write: "ERR_ACCESS_DENIED",
      spawn: "ERR_ACCESS_DENIED",
      worker: "ERR_ACCESS_DENIED",
      evalCode: expect.stringMatching(/EvalError|Code generation/i),
    });
  });
});
