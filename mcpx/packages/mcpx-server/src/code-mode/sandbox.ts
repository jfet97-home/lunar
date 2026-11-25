import { ChildProcess, fork } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import z from "zod/v4";

export const SANDBOX_OPS = ["call", "search", "schema", "servers"] as const;
export type SandboxOp = (typeof SANDBOX_OPS)[number];

export interface SandboxLimits {
  cpuMs: number;
  wallMs: number;
  memoryBytes: number;
  stackBytes: number;
  runnerHeapMb: number;
  maxRequestBytes: number;
  maxPendingRequests: number;
  maxLogBytes: number;
  maxResultBytes: number;
}

export interface SandboxRequest {
  op: SandboxOp;
  payload: string;
}

export interface SandboxLog {
  level: string;
  text: string;
}

export interface SandboxError {
  name: string;
  message: string;
  reason?: string;
}

export type SandboxOutcome =
  | { status: "completed"; result: string }
  | { status: "failed"; error: SandboxError }
  | { status: "timeout" }
  | { status: "cancelled" }
  | { status: "crashed"; detail: string };

export interface RunSandboxProps {
  runnerPath: string;
  code: string;
  limits: SandboxLimits;
  signal?: AbortSignal;
  /*
   * Answers one script request with reply JSON. `stopped` aborts once the
   * script can no longer receive the answer, so callers must not start new
   * work after it fires.
   */
  onRequest: (request: SandboxRequest, stopped: AbortSignal) => Promise<string>;
  onLog: (log: SandboxLog) => void;
}

const MAX_STDERR_CHARS = 4_000;

const childMessageSchema = z.union([
  z.object({ type: z.literal("ready") }).strict(),
  z
    .object({
      type: z.literal("request"),
      id: z.number().int().positive(),
      op: z.enum(SANDBOX_OPS),
      payload: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("log"),
      level: z.string().max(16),
      text: z.string(),
      truncated: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("done"),
      ok: z.literal(true),
      result: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("done"),
      ok: z.literal(false),
      error: z
        .object({
          name: z.string().max(200),
          message: z.string().max(4_000),
          stack: z.string().optional(),
          reason: z.string().max(50).optional(),
        })
        .strict(),
    })
    .strict(),
]);

/*
 * Node flags for the runner process. The permission model denies child
 * processes, workers, native addons, WASI and filesystem writes; reads are
 * limited to the runner and its engine packages. Eval-style host code
 * generation is disabled, and the environment is empty, so no gateway
 * credential reaches the process.
 */
export function buildRunnerExecArgv(
  runnerPath: string,
  heapMb: number,
): string[] {
  const requireFromRunner = createRequire(runnerPath);
  const coreEntry = requireFromRunner.resolve("quickjs-emscripten-core");
  const requireFromCore = createRequire(coreEntry);
  const readable = [
    path.dirname(runnerPath),
    packageRoot(coreEntry, "quickjs-emscripten-core"),
    packageRoot(
      requireFromRunner.resolve("@jitl/quickjs-wasmfile-release-sync"),
      "@jitl/quickjs-wasmfile-release-sync",
    ),
    packageRoot(
      requireFromCore.resolve("@jitl/quickjs-ffi-types"),
      "@jitl/quickjs-ffi-types",
    ),
  ];
  return [
    "--permission",
    ...[...new Set(readable)].map((entry) => `--allow-fs-read=${entry}`),
    "--disallow-code-generation-from-strings",
    `--max-old-space-size=${heapMb}`,
  ];
}

function packageRoot(entry: string, name: string): string {
  const marker = `${path.sep}node_modules${path.sep}${name.split("/").join(path.sep)}${path.sep}`;
  const index = entry.lastIndexOf(marker);
  if (index < 0) {
    throw new Error(`Cannot locate package ${name} from ${entry}`);
  }
  return entry.slice(0, index + marker.length - 1);
}

export function runSandbox(props: RunSandboxProps): Promise<SandboxOutcome> {
  const { runnerPath, code, limits, signal, onRequest, onLog } = props;
  return new Promise<SandboxOutcome>((resolve) => {
    const stopped = new AbortController();
    let settled = false;
    let stderr = "";
    let logBytes = 0;
    let child: ChildProcess | undefined;

    const settle = (outcome: SandboxOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      signal?.removeEventListener("abort", onAbort);
      stopped.abort();
      child?.kill("SIGKILL");
      resolve(outcome);
    };
    const onAbort = (): void => settle({ status: "cancelled" });
    const wallTimer = setTimeout(
      () => settle({ status: "timeout" }),
      limits.wallMs,
    );
    if (signal?.aborted) {
      settle({ status: "cancelled" });
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      child = fork(runnerPath, [], {
        execArgv: buildRunnerExecArgv(runnerPath, limits.runnerHeapMb),
        env: {},
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        serialization: "json",
      });
    } catch (error) {
      settle({
        status: "crashed",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const runner = child;

    runner.stderr?.setEncoding("utf8");
    runner.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_STDERR_CHARS) {
        stderr = (stderr + chunk).slice(0, MAX_STDERR_CHARS);
      }
    });
    runner.on("error", (error) => {
      settle({ status: "crashed", detail: error.message });
    });
    runner.on("exit", (exitCode, exitSignal) => {
      settle({
        status: "crashed",
        detail: `Runner exited before finishing (code ${exitCode ?? "none"}, signal ${exitSignal ?? "none"})${stderr ? `: ${stderr.trim()}` : ""}`,
      });
    });

    const reply = (id: number, payload: string): void => {
      if (settled || !runner.connected) return;
      runner.send({ type: "reply", id, payload });
    };

    runner.on("message", (raw: unknown) => {
      if (settled) return;
      const parsed = childMessageSchema.safeParse(raw);
      if (!parsed.success) {
        settle({ status: "crashed", detail: "Runner protocol violation" });
        return;
      }
      const message = parsed.data;
      switch (message.type) {
        case "ready":
          runner.send({
            type: "start",
            code,
            limits: {
              cpuMs: limits.cpuMs,
              memoryBytes: limits.memoryBytes,
              stackBytes: limits.stackBytes,
              maxRequestBytes: limits.maxRequestBytes,
              maxPendingRequests: limits.maxPendingRequests,
              maxLogBytes: limits.maxLogBytes,
              maxResultBytes: limits.maxResultBytes,
            },
          });
          return;
        case "log": {
          const remaining = limits.maxLogBytes - logBytes;
          if (remaining <= 0 || message.text.length === 0) return;
          const text = message.text.slice(0, remaining);
          logBytes += Buffer.byteLength(text);
          onLog({ level: message.level, text });
          return;
        }
        case "request": {
          if (Buffer.byteLength(message.payload) > limits.maxRequestBytes) {
            reply(
              message.id,
              JSON.stringify({
                ok: false,
                error: {
                  code: "request_too_large",
                  message: `Request exceeds ${limits.maxRequestBytes} bytes`,
                },
              }),
            );
            return;
          }
          const { id } = message;
          onRequest(
            { op: message.op, payload: message.payload },
            stopped.signal,
          )
            .then((payload) => reply(id, payload))
            .catch((error: unknown) =>
              reply(
                id,
                JSON.stringify({
                  ok: false,
                  error: {
                    code: "internal_error",
                    message:
                      error instanceof Error ? error.message : String(error),
                  },
                }),
              ),
            );
          return;
        }
        case "done":
          if (message.ok) {
            if (Buffer.byteLength(message.result) > limits.maxResultBytes) {
              settle({
                status: "failed",
                error: {
                  name: "LimitError",
                  message: `Script result exceeds ${limits.maxResultBytes} bytes`,
                  reason: "result",
                },
              });
              return;
            }
            settle({ status: "completed", result: message.result });
            return;
          }
          settle({
            status: "failed",
            error: {
              name: message.error.name,
              message: message.error.message,
              ...(message.error.reason ? { reason: message.error.reason } : {}),
            },
          });
          return;
      }
    });
  });
}
