import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { Logger } from "winston";
import { ApprovalRequester } from "./approval.js";
import { CodeModeGateway, executeCode } from "./execute.js";
import {
  CodeModeConfig,
  CodeModeLimits,
  CodeModeTrustPolicy,
  DEFAULT_CODE_MODE_LIMITS,
} from "./policy.js";
import { buildCodeModeTool } from "./tool.js";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import z from "zod/v4";

export interface CodeModeEnv {
  ENABLE_CODE_MODE: boolean;
  CODE_MODE_TRUSTED_READ_TOOLS: string[];
  CODE_MODE_TRUSTED_ANNOTATION_SERVERS: string[];
  CODE_MODE_CPU_MS: number;
  CODE_MODE_WALL_MS: number;
  CODE_MODE_MEMORY_MB: number;
  CODE_MODE_MAX_TOOL_CALLS: number;
  CODE_MODE_APPROVAL_TIMEOUT_MS: number;
}

export interface CodeModeOverrides {
  enabled?: boolean;
  runnerPath?: string;
  limits?: Partial<CodeModeLimits>;
  trust?: Partial<CodeModeTrustPolicy>;
}

export function codeModeConfigFromEnv(
  env: CodeModeEnv,
  overrides: CodeModeOverrides = {},
): CodeModeConfig {
  return {
    enabled: overrides.enabled ?? env.ENABLE_CODE_MODE,
    runnerPath: overrides.runnerPath,
    limits: {
      ...DEFAULT_CODE_MODE_LIMITS,
      cpuMs: env.CODE_MODE_CPU_MS,
      wallMs: env.CODE_MODE_WALL_MS,
      memoryBytes: env.CODE_MODE_MEMORY_MB * 1024 * 1024,
      maxToolCalls: env.CODE_MODE_MAX_TOOL_CALLS,
      approvalTimeoutMs: env.CODE_MODE_APPROVAL_TIMEOUT_MS,
      ...overrides.limits,
    },
    trust: {
      trustedReadTools: env.CODE_MODE_TRUSTED_READ_TOOLS,
      trustedAnnotationServers: env.CODE_MODE_TRUSTED_ANNOTATION_SERVERS,
      ...overrides.trust,
    },
  };
}

const executeArgsSchema = (
  limits: CodeModeLimits,
): z.ZodType<{ code: string }> =>
  z
    .object({
      code: z
        .string()
        .min(1)
        .refine(
          (code) => Buffer.byteLength(code) <= limits.maxCodeBytes,
          `code exceeds ${limits.maxCodeBytes} bytes`,
        ),
    })
    .strict();

export class CodeModeService {
  readonly available: boolean;
  readonly tool: Tool;
  private active = 0;
  private readonly logger: Logger;

  constructor(
    readonly config: CodeModeConfig,
    logger: Logger,
  ) {
    this.logger = logger.child({ component: "CodeMode" });
    this.tool = buildCodeModeTool(config.limits);
    this.available =
      config.enabled &&
      config.runnerPath !== undefined &&
      existsSync(config.runnerPath);
    if (config.enabled && !this.available) {
      this.logger.warn("Code Mode is enabled but its runner is unavailable", {
        runnerPath: config.runnerPath,
      });
    }
  }

  async execute(props: {
    args: Record<string, unknown>;
    gateway: CodeModeGateway;
    approve: ApprovalRequester;
    signal?: AbortSignal;
  }): Promise<CallToolResult> {
    const { runnerPath } = this.config;
    if (!this.available || runnerPath === undefined) {
      return errorResult("unavailable", "Code Mode is not available");
    }
    const parsed = executeArgsSchema(this.config.limits).safeParse(props.args);
    if (!parsed.success) {
      return errorResult(
        "invalid_arguments",
        parsed.error.issues.map(({ message }) => message).join("; "),
      );
    }
    if (this.active >= this.config.limits.maxConcurrentExecutions) {
      return errorResult(
        "busy",
        "Too many Code Mode scripts are running; nothing ran. Retry shortly.",
      );
    }
    this.active += 1;
    try {
      return await executeCode({
        code: parsed.data.code,
        runnerPath,
        limits: this.config.limits,
        trust: this.config.trust,
        gateway: props.gateway,
        approve: props.approve,
        signal: props.signal,
        logger: this.logger,
        executionId: randomUUID(),
      });
    } finally {
      this.active -= 1;
    }
  }
}

function errorResult(code: string, message: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: false,
          error: { code, message },
          calls: [],
        }),
      },
    ],
    isError: true,
  };
}
