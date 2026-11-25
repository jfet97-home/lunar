import { fork } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildRunnerExecArgv,
  formatSandboxLog,
  runSandbox,
  SandboxLimits,
  SandboxLog,
  SandboxOutcome,
  SandboxReply,
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
    ) => Promise<SandboxReply>;
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

  it("keeps the default schema request and forwards lookup options under the given name", async () => {
    const { outcome } = await run(`
      return [
        await mcpx.getToolSchema("docs__get_page"),
        await mcpx.getToolSchema("docs__get_page", { format: "compact" }),
        await mcpx.getToolSchema("docs__get_page", { name: "secrets__read" }),
        await mcpx.getToolSchema("docs__get_page", "compact"),
      ];
    `);
    expect(outcome).toEqual({
      status: "completed",
      result: JSON.stringify([
        { op: "schema", payload: { name: "docs__get_page" } },
        {
          op: "schema",
          payload: { format: "compact", name: "docs__get_page" },
        },
        { op: "schema", payload: { name: "docs__get_page" } },
        { op: "schema", payload: { name: "docs__get_page" } },
      ]),
    });
  });

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

  it.each([
    ["log", 4],
    ["warn", 11],
  ])(
    "truncates console.%s output at a complete UTF-8 character",
    async (level, maxLogBytes) => {
      const { outcome, logs } = await run(
        `console.${level}("aé🙂"); return 1;`,
        { limits: { maxLogBytes } },
      );
      expect(outcome.status).toBe("completed");
      expect(logs).toEqual([{ level, text: "aé" }]);
      expect(
        Buffer.byteLength(logs.map(formatSandboxLog).join("")),
      ).toBeLessThanOrEqual(maxLogBytes);
    },
  );

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

  it("reports a reply as sent only when it reached the runner", async () => {
    const sent: string[] = [];
    const { outcome } = await run(
      `
        await mcpx.callTool("t__awaited", {});
        mcpx.callTool("t__late", {});
        return "done";
      `,
      {
        onRequest: async (request) => {
          const { name } = JSON.parse(request.payload) as { name: string };
          // the late reply is ready only after the script returned
          if (name === "t__late") {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          return {
            payload: JSON.stringify({ ok: true, value: {} }),
            onSent: (): void => {
              sent.push(name);
            },
          };
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(outcome).toEqual({ status: "completed", result: '"done"' });
    expect(sent).toEqual(["t__awaited"]);
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

describe("mcpx.describe", () => {
  jest.setTimeout(30_000);

  async function describeIn(code: string): Promise<unknown> {
    const requests: SandboxRequest[] = [];
    const { outcome } = await run(code, {
      onRequest: async (request) => {
        requests.push(request);
        return JSON.stringify({ ok: true, value: {} });
      },
    });
    if (outcome.status !== "completed") {
      throw new Error(`Script did not complete: ${JSON.stringify(outcome)}`);
    }
    // describe is pure guest code and never asks the gateway for anything
    expect(requests).toEqual([]);
    return JSON.parse(outcome.result);
  }

  it("describes mixed values by type, keys and sampled array shapes", async () => {
    const shape = await describeIn(`
      return mcpx.describe({
        id: 7, name: "x", ok: true, none: null, missing: undefined,
        big: 12n, fn: () => 1, sym: Symbol("s"),
        tags: ["a", "b", "c", "d"],
        items: [{ id: 1, title: "t" }, { id: 2 }, { id: 3, title: "u" }, { id: 4 }],
        nested: { deep: { list: [] } },
      });
    `);
    expect(shape).toEqual({
      type: "object",
      keys: {
        id: "number",
        name: "string",
        ok: "boolean",
        none: "null",
        missing: "undefined",
        big: "bigint",
        fn: "function",
        sym: "symbol",
        tags: { type: "array", length: 4, items: ["string"], sampled: 3 },
        items: {
          type: "array",
          length: 4,
          items: [
            { type: "object", keys: { id: "number", title: "string" } },
            { type: "object", keys: { id: "number" } },
          ],
          sampled: 3,
        },
        nested: {
          type: "object",
          keys: {
            deep: {
              type: "object",
              keys: { list: { type: "array", length: 0, items: [] } },
            },
          },
        },
      },
    });
  });

  it("handles empty, primitive, cyclic and odd values predictably", async () => {
    const shapes = await describeIn(`
      const cyclic = { name: "a" };
      cyclic.self = cyclic;
      cyclic.list = [cyclic];
      const shared = { x: 1 };
      let getterRan = false;
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();
      const keyless = new Proxy({}, { ownKeys: () => { throw new Error("trap"); } });
      // Object.keys reads each descriptor once; the second read of "b" throws
      let reads = 0;
      const trap = new Proxy({ a: 1, b: 2 }, {
        getOwnPropertyDescriptor: (target, key) => {
          if (key === "b" && ++reads > 1) throw new Error("trap");
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
      const sparse = [];
      sparse.length = 5000000;
      const shapes = {
        null: mcpx.describe(null),
        undefined: mcpx.describe(undefined),
        none: mcpx.describe(),
        string: mcpx.describe("secret"),
        emptyArray: mcpx.describe([]),
        emptyObject: mcpx.describe({}),
        cyclic: mcpx.describe(cyclic),
        shared: mcpx.describe({ a: shared, b: shared }),
        getter: mcpx.describe({ get secret() { getterRan = true; return "s"; } }),
        classes: mcpx.describe({ when: new Date(0), map: new Map([[1, 2]]), bare: Object.create(null) }),
        // as text: a __proto__ key would become a prototype in an object literal
        proto: JSON.stringify(mcpx.describe(JSON.parse('{"__proto__": {"a": 1}}'))),
        revoked: mcpx.describe(revocable.proxy),
        keyless: mcpx.describe(keyless),
        trap: mcpx.describe(trap),
        sparse: mcpx.describe(sparse),
      };
      return { shapes, getterRan };
    `);
    expect(shapes).toEqual({
      getterRan: false,
      shapes: {
        null: "null",
        undefined: "undefined",
        none: "undefined",
        string: "string",
        emptyArray: { type: "array", length: 0, items: [] },
        emptyObject: { type: "object", keys: {} },
        cyclic: {
          type: "object",
          keys: {
            name: "string",
            self: "circular",
            list: { type: "array", length: 1, items: ["circular"] },
          },
        },
        shared: {
          type: "object",
          keys: {
            a: { type: "object", keys: { x: "number" } },
            b: { type: "object", keys: { x: "number" } },
          },
        },
        getter: { type: "object", keys: { secret: "accessor" } },
        // only own keys count; no class name is read from the value
        classes: {
          type: "object",
          keys: {
            when: { type: "object", keys: {} },
            map: { type: "object", keys: {} },
            bare: { type: "object", keys: {} },
          },
        },
        proto: JSON.stringify({
          type: "object",
          keys: JSON.parse(
            '{"__proto__": {"type": "object", "keys": {"a": "number"}}}',
          ),
        }),
        revoked: "unreadable",
        keyless: "unreadable",
        trap: { type: "object", keys: { a: "number", b: "unreadable" } },
        sparse: {
          type: "array",
          length: 5_000_000,
          items: ["undefined"],
          sampled: 3,
        },
      },
    });
  });

  it("runs no getter or get trap to classify a value, even a tag or array length", async () => {
    const result = await describeIn(`
      let tagReads = 0;
      let lengthReads = 0;
      const tagged = {
        id: 1,
        get [Symbol.toStringTag]() { tagReads++; return "private-fixture-value"; },
      };
      const list = new Proxy([1, 2, 3], {
        get: (target, key, receiver) => {
          if (key === "length") { lengthReads++; return "private-fixture-value"; }
          return Reflect.get(target, key, receiver);
        },
      });
      return {
        shapes: [mcpx.describe(tagged), mcpx.describe(list)],
        tagReads,
        lengthReads,
      };
    `);
    expect(result).toEqual({
      shapes: [
        { type: "object", keys: { id: "number" } },
        { type: "array", length: 3, items: ["number"] },
      ],
      tagReads: 0,
      lengthReads: 0,
    });
    expect(JSON.stringify(result)).not.toContain("private-fixture-value");
  });

  it("never returns values, even sensitive-looking ones", async () => {
    const shape = await describeIn(`
      return mcpx.describe({
        password: "hunter2-value",
        token: "sk-live-value",
        nested: [{ apiKey: "AKIA-value", count: 42 }],
        content: [{ type: "text", text: "Bearer abc-value" }],
      });
    `);
    const text = JSON.stringify(shape);
    for (const value of [
      "hunter2",
      "sk-live",
      "AKIA",
      "Bearer",
      "42",
      ':"text"',
    ]) {
      expect(text).not.toContain(value);
    }
    expect(shape).toMatchObject({
      keys: {
        password: "string",
        nested: { items: [{ keys: { apiKey: "string", count: "number" } }] },
        content: { items: [{ keys: { type: "string", text: "string" } }] },
      },
    });
  });

  it("bounds keys, key names, depth and total work", async () => {
    const result = (await describeIn(`
      const wide = {};
      for (let i = 0; i < 100; i++) wide["k" + i] = i;
      const long = {};
      long["a".repeat(200)] = 1;
      long["a".repeat(64) + "b"] = 2;
      // colliding cut names use the key budget, so "z" is past it
      const colliding = {};
      for (let i = 0; i < 30; i++) colliding["b".repeat(64) + i] = i;
      colliding.z = 1;
      let deep = "leaf";
      for (let i = 0; i < 20; i++) deep = { next: deep };
      const huge = {};
      for (let i = 0; i < 50; i++) {
        huge["k" + i] = Array.from({ length: 1000 }, () => wide);
      }
      const many = Array.from({ length: 50000 }, (_, id) => ({ id }));
      const hugeShape = mcpx.describe(huge);
      return {
        wide: mcpx.describe(wide),
        long: mcpx.describe(long),
        colliding: mcpx.describe(colliding),
        deep: mcpx.describe(deep),
        many: mcpx.describe(many),
        hugeShape,
        hugeBytes: JSON.stringify(hugeShape).length,
      };
    `)) as Record<string, unknown>;
    const wide = result["wide"] as { keys: object; moreKeys: number };
    expect(Object.keys(wide.keys)).toHaveLength(24);
    expect(wide.moreKeys).toBe(76);
    expect(result["long"]).toEqual({
      type: "object",
      keys: { [`${"a".repeat(64)}...`]: "number" },
      moreKeys: 1,
    });
    expect(result["colliding"]).toEqual({
      type: "object",
      keys: { [`${"b".repeat(64)}...`]: "number" },
      moreKeys: 30,
    });
    let level = result["deep"] as { keys?: { next: unknown } };
    for (let depth = 0; depth < 6; depth++) {
      expect(level).toMatchObject({ type: "object" });
      level = level.keys?.next as typeof level;
    }
    expect(level).toEqual({ type: "object", depthLimited: true });
    expect(result["many"]).toEqual({
      type: "array",
      length: 50_000,
      items: [{ type: "object", keys: { id: "number" } }],
      sampled: 3,
    });
    // the node budget stops the walk long before the 50 x 1000 x 100 input
    const countNodes = (shape: unknown): number => {
      if (typeof shape === "string") return 1;
      const node = shape as { keys?: object; items?: unknown[] };
      return (
        1 +
        Object.values(node.keys ?? {}).reduce(
          (sum: number, child) => sum + countNodes(child),
          0,
        ) +
        (node.items ?? []).reduce(
          (sum: number, child) => sum + countNodes(child),
          0,
        )
      );
    };
    expect(countNodes(result["hugeShape"])).toBeLessThanOrEqual(200);
    expect(result["hugeBytes"]).toBeLessThan(20_000);
    expect(result["hugeShape"]).toMatchObject({ type: "object", moreKeys: 47 });
  });
});

describe("Code Mode runner process permissions", () => {
  let probeDirectory: string | undefined;
  let probePath: string;

  beforeAll(() => {
    // the permission model compares real paths, and macOS links /var to /private/var
    probeDirectory = mkdtempSync(path.join(tmpdir(), "mcpx-code-mode-"));
    probeDirectory = realpathSync(probeDirectory);
    probePath = path.join(probeDirectory, "probe.mjs");
    const secretPath = path.join(probeDirectory, "forbidden-write");
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
    if (probeDirectory) {
      rmSync(probeDirectory, { recursive: true, force: true });
    }
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
