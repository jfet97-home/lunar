/*
 * Code Mode sandbox runner. The gateway starts this file in a separate Node
 * process with an empty environment and Node's permission model. Untrusted
 * script code runs only inside a QuickJS WebAssembly context, which has no
 * filesystem, network, process, timer or module access. Its only capability is
 * a string broker: requests leave as JSON text over IPC and the gateway
 * validates, authorizes and answers each one.
 *
 * This file must stay self-contained and use only erasable TypeScript syntax:
 * tests run it directly with Node's type stripping, production runs the tsc
 * output.
 */
import type {
  QuickJSContext,
  QuickJSDeferredPromise,
  QuickJSHandle,
  QuickJSRuntime,
  QuickJSSyncVariant,
} from "quickjs-emscripten-core";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import releaseSyncVariant from "@jitl/quickjs-wasmfile-release-sync";

interface RunnerLimits {
  cpuMs: number;
  memoryBytes: number;
  stackBytes: number;
  maxRequestBytes: number;
  maxPendingRequests: number;
  maxLogBytes: number;
  maxResultBytes: number;
}

interface StartMessage {
  type: "start";
  code: string;
  limits: RunnerLimits;
}

interface ReplyMessage {
  type: "reply";
  id: number;
  // JSON text of `{ ok: true, value } | { ok: false, error }`
  payload: string;
}

type ParentMessage = StartMessage | ReplyMessage;

interface FailureDetail {
  name: string;
  message: string;
  stack?: string;
  reason?:
    | "cpu"
    | "memory"
    | "stack"
    | "deadlock"
    | "result"
    | "request"
    | "internal";
}

const HOST_OPS = new Set(["call", "search", "schema", "servers"]);

const PRELUDE = `
(() => {
  const host = globalThis.__mcpxHost;
  const writeLog = globalThis.__mcpxLog;
  delete globalThis.__mcpxHost;
  delete globalThis.__mcpxLog;
  const request = async (op, payload) => {
    const reply = JSON.parse(await host(op, JSON.stringify(payload)));
    if (reply.ok) return reply.value;
    const error = new Error(reply.error.message);
    error.name = "McpxError";
    error.code = reply.error.code;
    if (reply.error.call !== undefined) error.call = reply.error.call;
    throw error;
  };
  const format = (value) => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return String(value);
    try {
      const text = JSON.stringify(value);
      return text === undefined ? String(value) : text;
    } catch {
      return String(value);
    }
  };
  const writer = (level) => (...values) => writeLog(level, values.map(format).join(" "));
  globalThis.console = Object.freeze({
    log: writer("log"),
    info: writer("info"),
    warn: writer("warn"),
    error: writer("error"),
    debug: writer("debug"),
  });
  const options = (value) => (value && typeof value === "object" ? value : {});
  // text joins the text blocks; data is structuredContent, else the text parsed as JSON
  const withConveniences = (result) => {
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\\n");
    let data = result.structuredContent;
    if (data === undefined && text !== "") {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
    return { ...result, text, data };
  };
  /*
   * A bounded shape description that never includes values. Leaves are type
   * names; arrays sample their first elements. Properties are read through
   * their own descriptors, so getters never run. The budgets cap the values
   * inspected and the output; listing one object's own keys is a single
   * engine step that counts against the script's CPU and memory budget.
   */
  const SHAPE = { depth: 6, keys: 24, items: 3, nodes: 200, keyChars: 64 };
  const own = (target, key) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor === undefined) return { value: undefined };
    return "value" in descriptor ? { value: descriptor.value } : { accessor: true };
  };
  const describe = (root) => {
    let nodes = 0;
    const ancestors = [];
    const entry = (target, key, depth) => {
      let read;
      try {
        read = own(target, key);
      } catch {
        return "unreadable";
      }
      return read.accessor ? "accessor" : shapeOf(read.value, depth);
    };
    const within = (value, walk) => {
      ancestors.push(value);
      try {
        return walk();
      } finally {
        ancestors.pop();
      }
    };
    const describeArray = (value, depth) => {
      // the own length property, so no getter or proxy get trap runs
      const length = own(value, "length").value;
      if (!Number.isSafeInteger(length) || length < 0) return "unreadable";
      const node = { type: "array", length };
      if (length === 0) return { ...node, items: [] };
      if (depth >= SHAPE.depth) return { ...node, depthLimited: true };
      const items = [];
      const seen = new Set();
      let sampled = 0;
      const wanted = Math.min(length, SHAPE.items);
      within(value, () => {
        while (sampled < wanted && nodes < SHAPE.nodes) {
          const shape = entry(value, String(sampled), depth + 1);
          sampled += 1;
          const key = JSON.stringify(shape);
          if (!seen.has(key)) {
            seen.add(key);
            items.push(shape);
          }
        }
      });
      node.items = items;
      if (sampled < length) node.sampled = sampled;
      return node;
    };
    const describeObject = (value, depth) => {
      const node = { type: "object" };
      if (depth >= SHAPE.depth) return { ...node, depthLimited: true };
      const names = Object.keys(value);
      const keys = {};
      let examined = 0;
      let listed = 0;
      within(value, () => {
        for (const name of names) {
          if (examined >= SHAPE.keys || nodes >= SHAPE.nodes) break;
          examined += 1;
          const label =
            name.length > SHAPE.keyChars ? name.slice(0, SHAPE.keyChars) + "..." : name;
          // a cut name that repeats a listed label still uses the key budget
          if (Object.prototype.hasOwnProperty.call(keys, label)) continue;
          // defineProperty keeps keys such as __proto__ as plain entries
          Object.defineProperty(keys, label, {
            value: entry(value, name, depth + 1),
            enumerable: true,
            writable: true,
            configurable: true,
          });
          listed += 1;
        }
      });
      node.keys = keys;
      if (listed < names.length) node.moreKeys = names.length - listed;
      return node;
    };
    const shapeOf = (value, depth) => {
      nodes += 1;
      if (value === null) return "null";
      if (typeof value !== "object") return typeof value;
      if (ancestors.includes(value)) return "circular";
      try {
        return Array.isArray(value)
          ? describeArray(value, depth)
          : describeObject(value, depth);
      } catch {
        // a revoked proxy or a throwing proxy trap
        return "unreadable";
      }
    };
    return shapeOf(root, 0);
  };
  globalThis.mcpx = Object.freeze({
    describe,
    callTool: async (name, args) =>
      withConveniences(
        await request("call", { name, arguments: args === undefined ? {} : args }),
      ),
    searchTools: (query, searchOptions) =>
      request("search", { ...options(searchOptions), query }),
    getToolSchema: (name, schemaOptions) =>
      request("schema", { ...options(schemaOptions), name }),
    listServers: () => request("servers", {}),
  });
})();
`;

function wrapUserCode(code: string): string {
  return `(async () => {\n${code}\n})().then((value) => {\n  const text = JSON.stringify(value === undefined ? null : value);\n  if (text === undefined) throw new TypeError("The script result is not JSON-serializable");\n  return text;\n})`;
}

function send(message: Record<string, unknown>): void {
  process.send?.(message);
}

let finished = false;

function finish(
  outcome: { ok: true; result: string } | { ok: false; error: FailureDetail },
): void {
  if (finished) return;
  finished = true;
  // exit only after IPC flushed the final message; the parent kills a runner that never exits
  process.send?.({ type: "done", ...outcome }, undefined, undefined, () =>
    process.exit(0),
  );
}

function describeGuestError(
  context: QuickJSContext,
  handle: QuickJSHandle,
): FailureDetail {
  const dumped: unknown = context.dump(handle);
  if (dumped && typeof dumped === "object") {
    const record = dumped as Record<string, unknown>;
    return {
      name: typeof record["name"] === "string" ? record["name"] : "Error",
      message:
        typeof record["message"] === "string"
          ? record["message"]
          : String(dumped),
      ...(typeof record["stack"] === "string"
        ? { stack: record["stack"] }
        : {}),
    };
  }
  return { name: "Error", message: String(dumped) };
}

async function run(start: StartMessage): Promise<void> {
  const { limits } = start;
  // the package types describe its CommonJS build; ESM loads the variant itself
  const quickjs = await newQuickJSWASMModuleFromVariant(
    releaseSyncVariant as unknown as QuickJSSyncVariant,
  );
  const runtime: QuickJSRuntime = quickjs.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);

  let cpuUsedMs = 0;
  let segmentStartedAt: number | undefined;
  let cpuExceeded = false;
  runtime.setInterruptHandler(() => {
    if (segmentStartedAt === undefined) return false;
    if (cpuUsedMs + (performance.now() - segmentStartedAt) > limits.cpuMs) {
      cpuExceeded = true;
      return true;
    }
    return false;
  });
  const measure = <T>(segment: () => T): T => {
    segmentStartedAt = performance.now();
    try {
      return segment();
    } finally {
      cpuUsedMs += performance.now() - segmentStartedAt;
      segmentStartedAt = undefined;
    }
  };

  const context = runtime.newContext();
  const pending = new Map<number, QuickJSDeferredPromise>();
  let nextRequestId = 1;
  let logBytes = 0;
  let logTruncated = false;

  const failure = (detail: FailureDetail): FailureDetail => {
    if (cpuExceeded) {
      return {
        name: "LimitError",
        message: `Script exceeded its CPU budget of ${limits.cpuMs} ms`,
        reason: "cpu",
      };
    }
    if (/out of memory/i.test(detail.message)) {
      return { ...detail, name: "LimitError", reason: "memory" };
    }
    if (
      detail.name === "InternalError" &&
      /stack overflow/i.test(detail.message)
    ) {
      return { ...detail, name: "LimitError", reason: "stack" };
    }
    return detail;
  };

  const rejectRequest = (code: string, message: string): QuickJSHandle => {
    const deferred = context.newPromise();
    const error = context.newString(
      JSON.stringify({ ok: false, error: { code, message } }),
    );
    deferred.resolve(error);
    error.dispose();
    return deferred.handle;
  };

  const hostFn = context.newFunction(
    "__mcpxHost",
    (opHandle, payloadHandle) => {
      const op = context.getString(opHandle);
      if (!HOST_OPS.has(op)) {
        return context.newError(`Unknown host operation: ${op}`);
      }
      if (pending.size >= limits.maxPendingRequests) {
        return rejectRequest(
          "too_many_pending_requests",
          `The script has ${limits.maxPendingRequests} unanswered requests; await some before sending more`,
        );
      }
      const payload = context.getString(payloadHandle);
      if (Buffer.byteLength(payload) > limits.maxRequestBytes) {
        return rejectRequest(
          "request_too_large",
          `Request exceeds ${limits.maxRequestBytes} bytes`,
        );
      }
      const deferred = context.newPromise();
      const id = nextRequestId++;
      pending.set(id, deferred);
      send({ type: "request", id, op, payload });
      return deferred.handle;
    },
  );
  context.setProp(context.global, "__mcpxHost", hostFn);
  hostFn.dispose();

  const logFn = context.newFunction("__mcpxLog", (levelHandle, textHandle) => {
    if (logTruncated) return;
    const level = context.getString(levelHandle);
    const text = context.getString(textHandle);
    const remaining = limits.maxLogBytes - logBytes;
    const bytes = Buffer.byteLength(text);
    if (bytes === 0) return;
    if (bytes > remaining) {
      logTruncated = true;
      send({
        type: "log",
        level,
        text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(
          Buffer.from(text).subarray(0, Math.max(remaining, 0)),
          { stream: true },
        ),
        truncated: true,
      });
      logBytes = limits.maxLogBytes;
      return;
    }
    logBytes += bytes;
    send({ type: "log", level, text });
  });
  context.setProp(context.global, "__mcpxLog", logFn);
  logFn.dispose();

  const prelude = measure(() => context.evalCode(PRELUDE, "mcpx-prelude.js"));
  if (prelude.error) {
    const detail = describeGuestError(context, prelude.error);
    prelude.error.dispose();
    finish({ ok: false, error: { ...detail, reason: "internal" } });
    return;
  }
  prelude.value.dispose();

  const evaluated = measure(() =>
    context.evalCode(wrapUserCode(start.code), "mcpx-script.js"),
  );
  if (evaluated.error) {
    const detail = failure(describeGuestError(context, evaluated.error));
    evaluated.error.dispose();
    finish({ ok: false, error: detail });
    return;
  }
  const promise = evaluated.value;

  const settle = (): void => {
    if (finished) return;
    const jobs = measure(() => runtime.executePendingJobs());
    if (jobs.error) {
      const detail = failure(describeGuestError(context, jobs.error));
      jobs.error.dispose();
      finish({ ok: false, error: detail });
      return;
    }
    const state = context.getPromiseState(promise);
    if (state.type === "pending") {
      if (pending.size === 0) {
        finish({
          ok: false,
          error: {
            name: "DeadlockError",
            message:
              "The script is waiting for a promise that can never settle",
            reason: "deadlock",
          },
        });
      }
      return;
    }
    if (state.type === "rejected") {
      const detail = failure(describeGuestError(context, state.error));
      state.error.dispose();
      finish({ ok: false, error: detail });
      return;
    }
    const result = context.getString(state.value);
    state.value.dispose();
    if (Buffer.byteLength(result) > limits.maxResultBytes) {
      finish({
        ok: false,
        error: {
          name: "LimitError",
          message: `Script result exceeds ${limits.maxResultBytes} bytes; return a smaller filtered value`,
          reason: "result",
        },
      });
      return;
    }
    finish({ ok: true, result });
  };

  process.on("message", (message: ParentMessage) => {
    if (finished || message.type !== "reply") return;
    const deferred = pending.get(message.id);
    if (!deferred) return;
    pending.delete(message.id);
    const value = context.newString(message.payload);
    deferred.resolve(value);
    value.dispose();
    deferred.dispose();
    guarded(settle);
  });

  settle();
}

function hostFailure(error: unknown): FailureDetail {
  const message = error instanceof Error ? error.message : String(error);
  // deep guest recursion can exhaust the host stack before QuickJS's own check
  if (error instanceof RangeError && /call stack/i.test(message)) {
    return {
      name: "LimitError",
      message: "Script exceeded its stack limit",
      reason: "stack",
    };
  }
  return { name: "RunnerError", message, reason: "internal" };
}

function guarded(action: () => void): void {
  try {
    action();
  } catch (error) {
    finish({ ok: false, error: hostFailure(error) });
  }
}

process.once("message", (message: ParentMessage) => {
  if (message.type !== "start") {
    finish({
      ok: false,
      error: {
        name: "ProtocolError",
        message: "Expected start message",
        reason: "internal",
      },
    });
    return;
  }
  run(message).catch((error: unknown) => {
    finish({ ok: false, error: hostFailure(error) });
  });
});
send({ type: "ready" });
