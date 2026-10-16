import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CallToolResultSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { noOpLogger } from "@aigw/core/logging";
import { ManualClock } from "@aigw/core/time";
import { ConfigService, DEFAULT_CONFIG } from "../config.js";
import { resetEnv } from "../env.js";
import type { RemoteTargetServer } from "../model/target-servers.js";
import { OAuthSessionManager } from "../server/oauth-session-manager.js";
import { CapabilityRegistry } from "./capability-registry.js";
import { CapabilityResolver } from "./capability-resolver.js";
import { DiskTokenStore } from "./disk-token-store.js";
import { OAuthConnectionHandler } from "./oauth-connection-handler.js";
import { SystemStateTracker } from "./system-state.js";
import { ToolTokenEstimator } from "./tool-token-estimator.js";
import {
  UpstreamHandler,
  type UpstreamHandlerConfig,
} from "./upstream-handler.js";
import type { ExtendedClientI, PingOutcome } from "./client-extension.js";
import { ControlPlaneService } from "./control-plane-service.js";
import {
  InternalCapabilitiesService,
  wireInternalCapabilityProvider,
} from "./internal-capabilities-service.js";
import { ManagementToolsService } from "./management-tools.js";
import { UpstreamSessionExpiredError } from "./streamable-http-reconnection.js";

describe("upstream recovery and OAuth logout", () => {
  let directory: string;
  let originalEnvironment: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnvironment = { ...process.env };
    process.env["VERSION"] = "test";
    process.env["INSTANCE_ID"] = "test-instance";
    process.env["ENABLE_PROMPT_CAPABILITY"] = "true";
    resetEnv();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "mcpx-logout-"));
  });

  afterEach(async () => {
    process.env = originalEnvironment;
    resetEnv({
      ...process.env,
      VERSION: process.env["VERSION"] ?? "test",
      INSTANCE_ID: process.env["INSTANCE_ID"] ?? "test-instance",
    });
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function makeHarness(
    serverName = "docs",
    overrides: Partial<UpstreamHandlerConfig> = {},
    initialize = false,
  ) {
    const targetServer: RemoteTargetServer = {
      name: serverName,
      type: "streamable-http",
      url: "https://example.com/mcp",
      description: "Documentation",
    };
    const config = new ConfigService(
      DEFAULT_CONFIG,
      { load: () => ({ success: true, data: DEFAULT_CONFIG }), save: () => {} },
      noOpLogger,
    );
    await config.initialize();
    const unsubscribeCatalog = jest.fn();
    const catalog = {
      subscribe: jest.fn(() => unsubscribeCatalog),
      getCatalog: () => [],
      getDisplayNameByName: () => undefined,
      getDisplayNameById: () => undefined,
      isServerApproved: () => true,
      isToolApproved: () => true,
      isPromptApproved: () => true,
      getPerCatalogItemOAuth: () => undefined,
    };
    const registry = new CapabilityRegistry(noOpLogger);
    const resolver = new CapabilityResolver(
      registry,
      catalog as never,
      { hasPermission: () => true },
      noOpLogger,
    );
    const state = new SystemStateTracker(new ManualClock(), noOpLogger);
    const store = new DiskTokenStore(directory, noOpLogger);
    const sessions = new OAuthSessionManager(
      noOpLogger,
      store,
      { resolveOauthCredential: () => undefined },
      catalog as never,
    );
    const provider = sessions.getOrCreateOAuthProvider({
      serverName,
      serverUrl: targetServer.url,
    });
    await provider.saveTokens({
      access_token: "old-token",
      refresh_token: "old-refresh",
      token_type: "bearer",
    });
    await provider.saveCodeVerifier("old-verifier");
    await provider.saveClientInformation?.({
      client_id: "old-client",
      redirect_uris: [],
    });
    const sessionExpiredListeners = new Set<
      (error: UpstreamSessionExpiredError) => void
    >();
    const extended = {
      close: jest.fn(async () => {}),
      isAlive: jest.fn(async (): Promise<PingOutcome> => null),
      onToolsListChanged: () => () => {},
      onPromptsListChanged: () => () => {},
      onSessionExpired(callback: (error: UpstreamSessionExpiredError) => void) {
        sessionExpiredListeners.add(callback);
        return () => sessionExpiredListeners.delete(callback);
      },
      listTools: jest.fn(async () => ({
        tools: [
          { name: "read", inputSchema: { type: "object", properties: {} } },
        ],
        toolParentNames: {},
      })),
      listPrompts: async () => ({ prompts: [] }),
      callTool: jest.fn(async () => ({ content: [] })),
      getPrompt: jest.fn(async () => ({ messages: [] })),
    };
    const oauth = new OAuthConnectionHandler(
      sessions,
      { build: async () => extended } as never,
      noOpLogger,
      {
        discoverOAuthProtectedResourceMetadata: async () => {
          throw new Error("No metadata");
        },
        discoverAuthorizationServerMetadata: async () => undefined,
        auth: async (freshProvider) => {
          await freshProvider.redirectToAuthorization(
            new URL("https://example.com/login"),
          );
          return "REDIRECT";
        },
      },
    );
    const writeConfig = jest.fn();
    const readConfig = jest.fn(() => [targetServer]);
    const createConnection = jest.fn(async () => extended);
    const upstream = new UpstreamHandler(
      state,
      {
        writeTargetServers: writeConfig,
        readTargetServers: readConfig,
      } as never,
      { createConnection } as never,
      oauth,
      catalog as never,
      new ToolTokenEstimator(),
      registry,
      resolver,
      config,
      noOpLogger,
      {
        pingIntervalMs: 0,
        pingTimeoutMs: 100,
        pingFailureThreshold: 3,
        reconnectBaseDelayMs: 10,
        ...overrides,
      },
    );
    if (initialize) await upstream.initialize();
    else await upstream.addClient(targetServer);
    return {
      targetServer,
      upstream,
      extended,
      createConnection,
      readConfig,
      catalog,
      unsubscribeCatalog,
      writeConfig,
      store,
      sessions,
      provider,
      registry,
      resolver,
      state,
      config,
      oauth,
      sessionExpiredListeners,
    };
  }

  async function callManagementAction(
    harness: Awaited<ReturnType<typeof makeHarness>>,
    action = "management_remove_server",
    args: Record<string, unknown> = { name: "docs" },
  ) {
    const controlPlane = new ControlPlaneService(
      harness.state,
      harness.upstream,
      harness.config,
      { get: () => true } as never,
      { log: jest.fn() } as never,
      noOpLogger,
    );
    const internal = new InternalCapabilitiesService(noOpLogger);
    const provider = new ManagementToolsService(
      {
        controlPlane,
        upstreamHandler: harness.upstream,
        setupManager: {} as never,
        localSavedSetups: {} as never,
        localExportService: {} as never,
        hubService: {} as never,
      } as never,
      { hasPermission: () => true },
      () => false,
      "http://localhost:9523/auth/callback",
      noOpLogger,
    );
    wireInternalCapabilityProvider(provider, internal, harness.registry);
    const entry = {
      serverName: "mcpx",
      capabilityName: action,
      origin: "internal" as const,
      definition: {
        ...harness.registry.servers
          .get("mcpx")!
          .tools!.find(({ definition }) => definition.name === action)!
          .definition,
        name: `mcpx__${action}`,
      },
    };
    return internal.dispatchTool(entry, args, {});
  }

  function getToolResponseJson(response: {
    content: Array<{ type: string; text?: string }>;
  }): Record<string, unknown> {
    const text = response.content.find((item) => item.type === "text")?.text;
    if (!text) throw new Error("Expected a text tool result");
    return JSON.parse(text) as Record<string, unknown>;
  }

  it("recovers the first expired session immediately without replaying a tool or touching another server", async () => {
    const harness = await makeHarness("Docs");
    const other = { ...harness.extended, close: jest.fn(async () => {}) };
    try {
      harness.createConnection.mockResolvedValueOnce(other);
      await harness.upstream.addClient({
        ...harness.targetServer,
        name: "other",
      });
      const otherCapabilities = harness.registry.servers.get("other");
      const tokens = await harness.provider.tokens();
      harness.writeConfig.mockClear();
      harness.extended.callTool.mockRejectedValueOnce(
        new UpstreamSessionExpiredError(),
      );
      await expect(
        harness.upstream.callTool("docs", { name: "read" }),
      ).rejects.toBeInstanceOf(UpstreamSessionExpiredError);
      expect(harness.createConnection).toHaveBeenCalledTimes(3);
      expect(harness.createConnection).toHaveBeenLastCalledWith(
        harness.targetServer,
        undefined,
        undefined,
      );
      expect(harness.extended.callTool).toHaveBeenCalledTimes(1);
      expect(
        harness.state
          .export()
          .targetServers.find((server) => server.name === "Docs")?.state.type,
      ).toBe("connected");
      expect(harness.registry.servers.get("other")).toBe(otherCapabilities);
      expect(other.close).not.toHaveBeenCalled();
      expect(await harness.provider.tokens()).toEqual(tokens);
      expect(harness.writeConfig).not.toHaveBeenCalled();
      await expect(
        harness.upstream.callTool("docs", { name: "read" }),
      ).resolves.toEqual({ content: [] });
    } finally {
      await harness.upstream.shutdown();
    }
  });

  it("shares recovery for concurrent expired calls and ignores a late failure from the old session", async () => {
    const harness = await makeHarness();
    let release!: (client: typeof harness.extended) => void;
    let lateFailure!: (error: Error) => void;
    const started = new Promise<void>((resolve) => {
      harness.createConnection.mockImplementationOnce(
        () =>
          new Promise((finish) => {
            release = finish;
            resolve();
          }),
      );
    });
    harness.extended.callTool.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          lateFailure = reject;
        }),
    );
    harness.extended.callTool.mockRejectedValueOnce(
      new UpstreamSessionExpiredError(),
    );
    harness.extended.callTool.mockRejectedValueOnce(
      new UpstreamSessionExpiredError(),
    );
    const lateCall = harness.upstream.callTool("docs", { name: "read" });
    const expiredCalls = Promise.allSettled([
      harness.upstream.callTool("docs", { name: "read" }),
      harness.upstream.callTool("docs", { name: "read" }),
    ]);
    const calls = Promise.allSettled([lateCall, expiredCalls]);
    try {
      await started;
      expect(harness.createConnection).toHaveBeenCalledTimes(2);
      release(harness.extended);
      const failures = await expiredCalls;
      expect(failures.every((result) => result.status === "rejected")).toBe(
        true,
      );
      lateFailure(new UpstreamSessionExpiredError());
      const results = await calls;
      expect(results[0]?.status).toBe("rejected");
      expect(harness.createConnection).toHaveBeenCalledTimes(2);
      expect(harness.extended.close).toHaveBeenCalledTimes(1);
      expect(harness.extended.callTool).toHaveBeenCalledTimes(3);
    } finally {
      await harness.upstream.shutdown();
    }
  });

  it("waits for session recovery when synchronous SDK closure masks the original expiry", async () => {
    const harness = await makeHarness();
    let release!: (client: typeof harness.extended) => void;
    const started = new Promise<void>((resolve) => {
      harness.createConnection.mockImplementationOnce(
        () =>
          new Promise((finish) => {
            release = finish;
            resolve();
          }),
      );
    });
    const closed = new McpError(
      ErrorCode.ConnectionClosed,
      "Connection closed",
    );
    harness.extended.callTool.mockImplementationOnce(async () => {
      for (const listener of [...harness.sessionExpiredListeners])
        listener(new UpstreamSessionExpiredError());
      throw closed;
    });
    let settled = false;
    const failedCall = harness.upstream
      .callTool("docs", { name: "read" })
      .catch((error: unknown) => {
        settled = true;
        return error;
      });
    try {
      await started;
      expect(settled).toBe(false);
      release(harness.extended);
      expect(await failedCall).toBe(closed);
      expect(harness.state.export().targetServers[0]?.state.type).toBe(
        "connected",
      );
      expect(harness.extended.callTool).toHaveBeenCalledTimes(1);
      await expect(
        harness.upstream.callTool("docs", { name: "read" }),
      ).resolves.toEqual({ content: [] });
    } finally {
      await harness.upstream.shutdown();
    }
  });

  it.each(["logout", "remove", "shutdown"])(
    "discards an expired-session handshake superseded by %s",
    async (action) => {
      const harness = await makeHarness();
      let release!: (client: typeof harness.extended) => void;
      const fresh = { ...harness.extended, close: jest.fn(async () => {}) };
      const started = new Promise<void>((resolve) => {
        harness.createConnection.mockImplementationOnce(
          () =>
            new Promise((finish) => {
              release = finish;
              resolve();
            }),
        );
      });
      harness.extended.callTool.mockRejectedValueOnce(
        new UpstreamSessionExpiredError(),
      );
      const call = expect(
        harness.upstream.callTool("docs", { name: "read" }),
      ).rejects.toBeInstanceOf(UpstreamSessionExpiredError);
      try {
        await started;
        if (action === "logout")
          await harness.upstream.logoutOAuthForServer("docs");
        else if (action === "remove")
          await harness.upstream.removeClient("docs");
        else await harness.upstream.shutdown();
        release(fresh);
        await call;
        expect(fresh.close).toHaveBeenCalledTimes(1);
        expect(fresh.listTools).toHaveBeenCalledTimes(1);
        if (action !== "shutdown") {
          expect(
            harness.registry.servers
              .get("docs")
              ?.tools?.some((tool) => tool.definition.name === "read"),
          ).not.toBe(true);
        }
        if (action === "logout")
          expect(harness.state.export().targetServers[0]?.state.type).toBe(
            "pending-auth",
          );
        if (action === "remove")
          expect(harness.state.export().targetServers).toHaveLength(0);
      } finally {
        await harness.upstream.shutdown();
      }
    },
  );

  it("falls back to normal retries when fresh initialization fails", async () => {
    jest.useFakeTimers();
    const harness = await makeHarness();
    try {
      harness.extended.callTool.mockRejectedValueOnce(
        new UpstreamSessionExpiredError(),
      );
      harness.createConnection.mockRejectedValueOnce(new Error("offline"));
      await expect(
        harness.upstream.callTool("docs", { name: "read" }),
      ).rejects.toBeInstanceOf(UpstreamSessionExpiredError);
      expect(harness.state.export().targetServers[0]?.state.type).toBe(
        "connection-failed",
      );
      await jest.advanceTimersByTimeAsync(10);
      expect(harness.state.export().targetServers[0]?.state.type).toBe(
        "connected",
      );
      expect(harness.createConnection).toHaveBeenCalledTimes(3);
      expect(harness.extended.callTool).toHaveBeenCalledTimes(1);
    } finally {
      await harness.upstream.shutdown();
      jest.useRealTimers();
    }
  });

  it("recovers session expiry reported by a notification stream", async () => {
    const harness = await makeHarness();
    let release!: (client: typeof harness.extended) => void;
    const started = new Promise<void>((resolve) => {
      harness.createConnection.mockImplementationOnce(
        () =>
          new Promise((finish) => {
            release = finish;
            resolve();
          }),
      );
    });
    try {
      const listeners = [...harness.sessionExpiredListeners];
      expect(listeners).toHaveLength(1);
      harness.extended.isAlive.mockResolvedValueOnce(
        new UpstreamSessionExpiredError(),
      );
      listeners[0]!(new UpstreamSessionExpiredError("GET"));
      listeners[0]!(new UpstreamSessionExpiredError("GET"));
      await started;
      expect(harness.createConnection).toHaveBeenCalledTimes(2);
      expect(harness.extended.isAlive).toHaveBeenCalledTimes(1);
      expect(harness.extended.isAlive).toHaveBeenCalledWith(100, true);
      release(harness.extended);
      for (let step = 0; step < 20; step++) await Promise.resolve();
      expect(harness.state.export().targetServers[0]?.state.type).toBe(
        "connected",
      );
      expect(harness.sessionExpiredListeners.size).toBe(1);
      expect(harness.extended.callTool).not.toHaveBeenCalled();
    } finally {
      await harness.upstream.shutdown();
    }
  });

  it.each([
    null,
    new McpError(ErrorCode.InternalError, "Ping application error"),
  ])(
    "keeps a usable POST session after GET 404 and can still recover a later POST expiry (%s)",
    async (outcome) => {
      const harness = await makeHarness();
      try {
        harness.extended.isAlive.mockResolvedValue(outcome);
        const listener = [...harness.sessionExpiredListeners][0]!;
        for (let attempt = 0; attempt < 3; attempt++) {
          listener(new UpstreamSessionExpiredError("GET"));
          for (let step = 0; step < 20; step++) await Promise.resolve();
        }
        expect(harness.extended.isAlive).toHaveBeenCalledTimes(3);
        expect(harness.createConnection).toHaveBeenCalledTimes(1);
        expect(harness.extended.close).not.toHaveBeenCalled();
        await expect(
          harness.upstream.callTool("docs", { name: "read" }),
        ).resolves.toEqual({ content: [] });
        harness.extended.callTool.mockRejectedValueOnce(
          new UpstreamSessionExpiredError(),
        );
        await expect(
          harness.upstream.callTool("docs", { name: "read" }),
        ).rejects.toBeInstanceOf(UpstreamSessionExpiredError);
        expect(harness.createConnection).toHaveBeenCalledTimes(2);
      } finally {
        await harness.upstream.shutdown();
      }
    },
  );

  it("does not restore a removed server after its GET-session probe finishes", async () => {
    const harness = await makeHarness();
    let release!: (outcome: PingOutcome) => void;
    harness.extended.isAlive.mockImplementationOnce(
      () =>
        new Promise((finish) => {
          release = finish;
        }),
    );
    try {
      [...harness.sessionExpiredListeners][0]!(
        new UpstreamSessionExpiredError("GET"),
      );
      await harness.upstream.removeClient("docs");
      release(new UpstreamSessionExpiredError());
      for (let step = 0; step < 20; step++) await Promise.resolve();
      expect(harness.createConnection).toHaveBeenCalledTimes(1);
      expect(harness.state.export().targetServers).toHaveLength(0);
      expect(harness.registry.servers.get("docs")).toBeUndefined();
    } finally {
      await harness.upstream.shutdown();
    }
  });

  it("uses normal failure thresholds for unconfirmed GET expiry instead of repeatedly initializing", async () => {
    const harness = await makeHarness();
    harness.extended.isAlive.mockResolvedValue(new Error("HTTP 503 from ping"));
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        [...harness.sessionExpiredListeners][0]!(
          new UpstreamSessionExpiredError("GET"),
        );
        for (let step = 0; step < 20; step++) await Promise.resolve();
      }
      expect(harness.createConnection).toHaveBeenCalledTimes(1);
      expect(harness.extended.close).not.toHaveBeenCalled();
      expect(harness.extended.isAlive).toHaveBeenCalledTimes(2);
      await expect(
        harness.upstream.callTool("docs", { name: "read" }),
      ).resolves.toEqual({ content: [] });
    } finally {
      await harness.upstream.shutdown();
    }
  });

  it("still replaces an expired POST session when it overlaps a successful GET probe", async () => {
    const harness = await makeHarness();
    let release!: (outcome: PingOutcome) => void;
    harness.extended.isAlive.mockImplementationOnce(
      () =>
        new Promise((finish) => {
          release = finish;
        }),
    );
    try {
      [...harness.sessionExpiredListeners][0]!(
        new UpstreamSessionExpiredError("GET"),
      );
      const postStarted = new Promise<void>((resolve) => {
        harness.extended.callTool.mockImplementationOnce(async () => {
          resolve();
          throw new UpstreamSessionExpiredError();
        });
      });
      const failed = expect(
        harness.upstream.callTool("docs", { name: "read" }),
      ).rejects.toBeInstanceOf(UpstreamSessionExpiredError);
      await postStarted;
      for (let step = 0; step < 20; step++) await Promise.resolve();
      release(null);
      await failed;
      expect(harness.createConnection).toHaveBeenCalledTimes(2);
      expect(harness.state.export().targetServers[0]?.state.type).toBe(
        "connected",
      );
      expect(harness.extended.callTool).toHaveBeenCalledTimes(1);
    } finally {
      await harness.upstream.shutdown();
    }
  });

  it("does not suppress OAuth recovery while an optional GET probe is pending", async () => {
    const harness = await makeHarness();
    let release!: (outcome: PingOutcome) => void;
    harness.extended.isAlive.mockImplementationOnce(
      () =>
        new Promise((finish) => {
          release = finish;
        }),
    );
    try {
      [...harness.sessionExpiredListeners][0]!(
        new UpstreamSessionExpiredError("GET"),
      );
      harness.extended.callTool.mockRejectedValueOnce(
        new Error("401 Unauthorized"),
      );
      const authRecovery = jest
        .spyOn(harness.oauth, "safeTryWithExistingTokens")
        .mockResolvedValue(harness.extended as unknown as ExtendedClientI);
      await expect(
        harness.upstream.callTool("docs", { name: "read" }),
      ).resolves.toEqual({ content: [] });
      expect(authRecovery).toHaveBeenCalledTimes(1);
      release(new UpstreamSessionExpiredError());
      for (let step = 0; step < 20; step++) await Promise.resolve();
      expect(harness.createConnection).toHaveBeenCalledTimes(1);
      expect(harness.state.export().targetServers[0]?.state.type).toBe(
        "connected",
      );
    } finally {
      await harness.upstream.shutdown();
    }
  });

  it("recovers an expired ping without waiting for the failure threshold", async () => {
    jest.useFakeTimers();
    const harness = await makeHarness("docs", { pingIntervalMs: 10 });
    try {
      harness.extended.isAlive.mockResolvedValueOnce(
        new UpstreamSessionExpiredError(),
      );
      await jest.advanceTimersByTimeAsync(10);
      expect(harness.createConnection).toHaveBeenCalledTimes(2);
      expect(harness.state.export().targetServers[0]?.state.type).toBe(
        "connected",
      );
      expect(harness.extended.callTool).not.toHaveBeenCalled();
    } finally {
      await harness.upstream.shutdown();
      jest.useRealTimers();
    }
  });

  it("reuses OAuth authentication while replacing an expired MCP session", async () => {
    const harness = await makeHarness();
    try {
      const tokens = await harness.provider.tokens();
      jest.spyOn(harness.oauth, "hasStaticOAuthForUrl").mockReturnValue(true);
      const resolveAuth = jest
        .spyOn(harness.oauth, "resolveExistingAuth")
        .mockResolvedValue({
          kind: "connected",
          client: harness.extended as unknown as ExtendedClientI,
        });
      harness.extended.callTool.mockRejectedValueOnce(
        new UpstreamSessionExpiredError(),
      );
      await expect(
        harness.upstream.callTool("docs", { name: "read" }),
      ).rejects.toBeInstanceOf(UpstreamSessionExpiredError);
      expect(resolveAuth).toHaveBeenCalledTimes(1);
      expect(harness.state.export().targetServers[0]?.state.type).toBe(
        "connected",
      );
      expect(await harness.provider.tokens()).toEqual(tokens);
      expect(harness.extended.callTool).toHaveBeenCalledTimes(1);
    } finally {
      await harness.upstream.shutdown();
    }
  });

  it("does not interpret an application's 404 as an expired HTTP session", async () => {
    const harness = await makeHarness();
    try {
      harness.extended.callTool.mockRejectedValueOnce(
        new McpError(404, "Recording not found"),
      );
      await expect(
        harness.upstream.callTool("docs", { name: "read" }),
      ).rejects.toThrow("Recording not found");
      expect(harness.createConnection).toHaveBeenCalledTimes(1);
      expect(harness.extended.close).not.toHaveBeenCalled();
    } finally {
      await harness.upstream.shutdown();
    }
  });

  it.each(["management_update_server", "management_refresh_server"])(
    "%s replaces same-name schemas without replacing connections or credentials",
    async (action) => {
      const harness = await makeHarness("docs", {}, true);
      const other = {
        ...harness.extended,
        close: jest.fn(async () => {}),
        listTools: jest.fn(async () => ({ tools: [], toolParentNames: {} })),
      };
      try {
        harness.createConnection.mockResolvedValueOnce(other);
        await harness.upstream.addClient({
          ...harness.targetServer,
          name: "other",
        });
        const otherCalls = other.listTools.mock.calls.length;
        const otherCapabilities = harness.registry.servers.get("other");
        const tokens = await harness.provider.tokens();
        const onChanged = jest.fn();
        harness.resolver.onChanged(onChanged);
        harness.writeConfig.mockClear();
        const updatedTool = {
          name: "read",
          description: "Updated documentation reader",
          inputSchema: {
            type: "object" as const,
            properties: { revision: { type: "string" } },
            required: ["revision"],
          },
          outputSchema: {
            type: "object" as const,
            properties: { current: { type: "boolean" } },
          },
          annotations: { readOnlyHint: true },
        };
        harness.extended.listTools.mockResolvedValue({
          tools: [updatedTool],
          toolParentNames: {},
        });
        const { name, ...config } = harness.targetServer;
        const response = await callManagementAction(
          harness,
          action,
          action === "management_update_server" ? { name, config } : { name },
        );

        expect(response.isError).not.toBe(true);
        expect(
          harness.resolver.resolveToolCall("docs__read", {}),
        ).toMatchObject({
          ok: true,
          entry: { definition: { ...updatedTool, name: "docs__read" } },
        });
        expect(onChanged).toHaveBeenCalledWith("tools");
        expect(harness.registry.servers.get("other")).toBe(otherCapabilities);
        expect(other.listTools).toHaveBeenCalledTimes(otherCalls);
        expect(harness.createConnection).toHaveBeenCalledTimes(2);
        expect(harness.extended.close).not.toHaveBeenCalled();
        expect(other.close).not.toHaveBeenCalled();
        expect(harness.extended.callTool).not.toHaveBeenCalled();
        expect(await harness.provider.tokens()).toEqual(tokens);
        expect(harness.upstream.servers).toEqual([
          harness.targetServer,
          { ...harness.targetServer, name: "other" },
        ]);
        if (action === "management_refresh_server") {
          expect(
            getToolResponseJson(CallToolResultSchema.parse(response)),
          ).toEqual({
            name: "docs",
            refreshed: true,
          });
          expect(harness.writeConfig).not.toHaveBeenCalled();
        }
      } finally {
        await harness.upstream.shutdown();
      }
    },
  );

  it("reports a discovery failure without losing the last known tools or credentials", async () => {
    const harness = await makeHarness("docs", {}, true);
    try {
      const tokens = await harness.provider.tokens();
      harness.extended.listTools.mockRejectedValue(
        new Error("discovery failed"),
      );
      const response = await callManagementAction(
        harness,
        "management_refresh_server",
      );
      expect(response.isError).toBe(true);
      expect(harness.resolver.resolveToolCall("docs__read", {}).ok).toBe(true);
      expect(harness.extended.close).not.toHaveBeenCalled();
      expect(await harness.provider.tokens()).toEqual(tokens);
    } finally {
      await harness.upstream.shutdown();
    }
  });

  it("does not report a stale in-flight refresh as successful after logout", async () => {
    const harness = await makeHarness("docs", {}, true);
    try {
      let finish!: (value: {
        tools: [];
        toolParentNames: Record<string, string>;
      }) => void;
      harness.extended.listTools.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const refresh = harness.upstream.refreshServerTools("docs");
      const rejected = expect(refresh).rejects.toThrow();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await harness.upstream.logoutOAuthForServer("docs");
      finish({ tools: [], toolParentNames: {} });
      await rejected;
      expect(harness.state.export().targetServers[0]?.state.type).toBe(
        "pending-auth",
      );
      expect(harness.resolver.resolveToolCall("docs__read", {}).ok).toBe(false);
    } finally {
      await harness.upstream.shutdown();
    }
  });

  it("recovers within five minutes after a long outage without rewriting credentials", async () => {
    jest.useFakeTimers();
    const harness = await makeHarness();
    try {
      const outage = new TypeError("fetch failed");
      harness.extended.callTool.mockRejectedValue(outage);
      harness.createConnection.mockRejectedValue(outage);
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(
          harness.upstream.callTool("docs", { name: "read" }),
        ).rejects.toThrow("fetch failed");
      }
      await jest.advanceTimersByTimeAsync(0);
      expect(harness.state.export().targetServers[0]?.state.type).toBe(
        "connection-failed",
      );
      await jest.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);

      harness.createConnection.mockResolvedValue(harness.extended);
      harness.extended.callTool.mockResolvedValue({ content: [] });
      await jest.advanceTimersByTimeAsync(5 * 60 * 1000);

      expect(harness.state.export().targetServers[0]?.state.type).toBe(
        "connected",
      );
      expect(harness.resolver.resolveToolCall("docs__read", {}).ok).toBe(true);
      await expect(
        harness.upstream.callTool("docs", { name: "read" }),
      ).resolves.toEqual({ content: [] });
      expect(harness.writeConfig).toHaveBeenCalledTimes(1);
      expect(await harness.provider.tokens()).toMatchObject({
        access_token: "old-token",
        refresh_token: "old-refresh",
      });
    } finally {
      await harness.upstream.shutdown();
      jest.useRealTimers();
    }
  });

  it("schedules recovery when capability discovery fails after silent OAuth recovery", async () => {
    jest.useFakeTimers();
    const harness = await makeHarness();
    try {
      harness.extended.callTool.mockRejectedValueOnce(
        new Error("401 Unauthorized"),
      );
      harness.extended.listTools.mockRejectedValueOnce(
        new Error("fetch failed"),
      );
      jest
        .spyOn(harness.oauth, "safeTryWithExistingTokens")
        .mockResolvedValue(harness.extended as unknown as ExtendedClientI);
      await expect(
        harness.upstream.callTool("docs", { name: "read" }),
      ).rejects.toThrow();
      expect(harness.state.export().targetServers[0]?.state.type).toBe(
        "connection-failed",
      );
      await jest.advanceTimersByTimeAsync(10);
      expect(harness.state.export().targetServers[0]?.state.type).toBe(
        "connected",
      );
      expect(harness.createConnection).toHaveBeenCalledTimes(2);
      expect(harness.writeConfig).toHaveBeenCalledTimes(1);
      expect(await harness.provider.tokens()).toMatchObject({
        access_token: "old-token",
      });
    } finally {
      await harness.upstream.shutdown();
      jest.useRealTimers();
    }
  });

  it.each([
    ["docs", ErrorCode.RequestTimeout],
    ["Docs", ErrorCode.ConnectionClosed],
  ])(
    "counts SDK failures for %s without replaying calls",
    async (name, code) => {
      jest.useFakeTimers();
      const harness = await makeHarness(String(name));
      try {
        harness.extended.callTool.mockRejectedValue(
          new McpError(Number(code), "Request failed"),
        );
        for (let attempt = 0; attempt < 3; attempt++) {
          await expect(
            harness.upstream.callTool(String(name), { name: "read" }),
          ).rejects.toThrow();
        }
        await jest.advanceTimersByTimeAsync(0);
        expect(harness.state.export().targetServers[0]?.state.type).toBe(
          "connection-failed",
        );
        await jest.advanceTimersByTimeAsync(10);
        expect(harness.createConnection).toHaveBeenCalledTimes(2);
        expect(harness.extended.callTool).toHaveBeenCalledTimes(3);
        expect(harness.state.export().targetServers[0]?.state.type).toBe(
          "connected",
        );
      } finally {
        await harness.upstream.shutdown();
        jest.useRealTimers();
      }
    },
  );

  it("does not let timed-out calls reset failed pings", async () => {
    jest.useFakeTimers();
    const harness = await makeHarness("docs", { pingIntervalMs: 10 });
    try {
      harness.extended.isAlive.mockResolvedValue(new Error("unreachable"));
      harness.extended.callTool.mockRejectedValue(
        new McpError(ErrorCode.RequestTimeout, "timed out"),
      );
      await jest.advanceTimersByTimeAsync(10);
      await expect(
        harness.upstream.callTool("docs", { name: "read" }),
      ).rejects.toThrow();
      await jest.advanceTimersByTimeAsync(10);
      expect(harness.state.export().targetServers[0]?.state.type).toBe(
        "connection-failed",
      );
      await jest.advanceTimersByTimeAsync(10);
      expect(harness.createConnection).toHaveBeenCalledTimes(2);
    } finally {
      await harness.upstream.shutdown();
      jest.useRealTimers();
    }
  });

  it("does not reconnect a healthy pinging server because parallel tool calls are slow", async () => {
    jest.useFakeTimers();
    const harness = await makeHarness("docs", { pingIntervalMs: 10 });
    try {
      await jest.advanceTimersByTimeAsync(10);
      harness.extended.callTool.mockRejectedValue(
        new McpError(ErrorCode.RequestTimeout, "timed out"),
      );
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(
          harness.upstream.callTool("docs", { name: "read" }),
        ).rejects.toThrow();
      }
      await jest.advanceTimersByTimeAsync(30);
      expect(harness.state.export().targetServers[0]?.state.type).toBe(
        "connected",
      );
      expect(harness.createConnection).toHaveBeenCalledTimes(1);
      expect(harness.extended.callTool).toHaveBeenCalledTimes(3);
    } finally {
      await harness.upstream.shutdown();
      jest.useRealTimers();
    }
  });

  it("retries one failed server immediately, coalesces concurrent requests, and preserves credentials", async () => {
    jest.useFakeTimers();
    const harness = await makeHarness();
    try {
      harness.extended.callTool.mockRejectedValue(new Error("fetch failed"));
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(
          harness.upstream.callTool("docs", { name: "read" }),
        ).rejects.toThrow();
      }
      await jest.advanceTimersByTimeAsync(0);
      let finish!: (client: typeof harness.extended) => void;
      harness.createConnection.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const first = harness.upstream.reconnectServer("Docs");
      await jest.advanceTimersByTimeAsync(0);
      expect(await harness.upstream.reconnectServer("docs")).toBe(false);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(harness.createConnection).toHaveBeenCalledTimes(2);
      finish(harness.extended);
      expect(await first).toBe(true);
      expect(await harness.upstream.reconnectServer("docs")).toBe(false);
      await jest.advanceTimersByTimeAsync(5 * 60_000);
      expect(harness.createConnection).toHaveBeenCalledTimes(2);
      expect(harness.writeConfig).toHaveBeenCalledTimes(1);
      expect(await harness.provider.tokens()).toMatchObject({
        access_token: "old-token",
      });
    } finally {
      await harness.upstream.shutdown();
      jest.useRealTimers();
    }
  });

  it("does not force retry a pending OAuth login", async () => {
    const harness = await makeHarness();
    try {
      await harness.upstream.logoutOAuthForServer("docs");
      expect(await harness.upstream.reconnectServer("docs")).toBe(false);
      expect(harness.createConnection).toHaveBeenCalledTimes(1);
      expect(harness.state.export().targetServers[0]?.state.type).toBe(
        "pending-auth",
      );
    } finally {
      await harness.upstream.shutdown();
    }
  });

  it("reloads configuration without duplicating subscriptions or retrying removed servers", async () => {
    jest.useFakeTimers();
    const harness = await makeHarness();
    const subscribe = jest.spyOn(harness.config, "subscribe");
    const intervals = jest.spyOn(global, "setInterval");
    const initialCatalogSubscribers =
      harness.catalog.subscribe.mock.calls.length;
    try {
      await harness.upstream.initialize();
      await harness.upstream.initialize();
      await harness.upstream.reloadFromConfig();
      await harness.upstream.reloadFromConfig();
      expect(harness.catalog.subscribe).toHaveBeenCalledTimes(
        initialCatalogSubscribers + 1,
      );
      expect(subscribe).toHaveBeenCalledTimes(1);
      expect(intervals).toHaveBeenCalledTimes(1);
      expect(await harness.provider.tokens()).toMatchObject({
        access_token: "old-token",
      });

      harness.extended.callTool.mockRejectedValue(new Error("fetch failed"));
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(
          harness.upstream.callTool("docs", { name: "read" }),
        ).rejects.toThrow();
      }
      await jest.advanceTimersByTimeAsync(0);
      harness.readConfig.mockReturnValue([]);
      await harness.upstream.reloadFromConfig();
      const attempts = harness.createConnection.mock.calls.length;
      await jest.advanceTimersByTimeAsync(60_000);
      expect(harness.createConnection).toHaveBeenCalledTimes(attempts);
      expect(harness.upstream.servers).toEqual([]);
      expect(harness.resolver.resolveToolCall("docs__read", {}).ok).toBe(false);
      expect(await harness.provider.tokens()).toMatchObject({
        access_token: "old-token",
      });
    } finally {
      await harness.upstream.shutdown();
      expect(harness.unsubscribeCatalog).toHaveBeenCalledTimes(1);
      subscribe.mockRestore();
      intervals.mockRestore();
      jest.useRealTimers();
    }
  });

  it("ignores a reconnect that completes after a configuration reload removes its server", async () => {
    jest.useFakeTimers();
    const harness = await makeHarness();
    try {
      await harness.upstream.initialize();
      harness.extended.callTool.mockRejectedValue(new Error("fetch failed"));
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(
          harness.upstream.callTool("docs", { name: "read" }),
        ).rejects.toThrow();
      }
      await jest.advanceTimersByTimeAsync(0);
      let finish!: (client: typeof harness.extended) => void;
      harness.createConnection.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const reconnect = harness.upstream.reconnectServer("docs");
      await jest.advanceTimersByTimeAsync(0);
      harness.readConfig.mockReturnValue([]);
      await harness.upstream.reloadFromConfig();
      finish(harness.extended);
      await reconnect;
      expect(harness.upstream.servers).toEqual([]);
      expect(harness.resolver.resolveToolCall("docs__read", {}).ok).toBe(false);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(harness.createConnection).toHaveBeenCalledTimes(3);
    } finally {
      await harness.upstream.shutdown();
      jest.useRealTimers();
    }
  });

  it("keeps retrying after an unexpected state-publication failure", async () => {
    jest.useFakeTimers();
    const harness = await makeHarness();
    try {
      harness.extended.callTool.mockRejectedValue(new Error("fetch failed"));
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(
          harness.upstream.callTool("docs", { name: "read" }),
        ).rejects.toThrow();
      }
      await jest.advanceTimersByTimeAsync(0);
      jest
        .spyOn(harness.state, "recordTargetServerConnection")
        .mockImplementationOnce(() => {
          throw new Error("state publication failed");
        });
      await jest.advanceTimersByTimeAsync(10);
      expect(harness.state.export().targetServers[0]?.state.type).toBe(
        "connection-failed",
      );
      await jest.advanceTimersByTimeAsync(20);
      expect(harness.state.export().targetServers[0]?.state.type).toBe(
        "connected",
      );
    } finally {
      await harness.upstream.shutdown();
      jest.useRealTimers();
    }
  });

  it.each(["docs", "Docs"])(
    "clears credentials and callbacks for %s, retains config and allows fresh login",
    async (serverName) => {
      const harness = await makeHarness(serverName);
      try {
        harness.sessions.startOAuthFlow(
          serverName,
          harness.targetServer.url,
          "old-state",
        );
        expect(harness.resolver.resolveToolCall("docs__read", {}).ok).toBe(
          true,
        );
        expect(harness.state.export().targetServers[0]).toMatchObject({
          oauth: true,
        });
        const writes = harness.writeConfig.mock.calls.length;
        await harness.upstream.logoutOAuthForServer("  Docs ");
        expect(harness.extended.close).toHaveBeenCalled();
        expect(await fs.readdir(directory)).toEqual([]);
        expect(harness.sessions.getOAuthFlow("old-state")).toBeUndefined();
        expect(harness.resolver.resolveToolCall("docs__read", {}).ok).toBe(
          false,
        );
        expect(
          harness.registry.servers
            .get("docs")
            ?.tools?.every((tool) => tool.origin === "internal"),
        ).toBe(true);
        expect(harness.state.export().targetServers[0]?.state).toEqual({
          type: "pending-auth",
        });
        expect(harness.upstream.servers).toEqual([harness.targetServer]);
        expect(harness.writeConfig).toHaveBeenCalledTimes(writes);
        await expect(
          harness.upstream.callTool("docs", { name: "read" }),
        ).rejects.toThrow();
        await expect(
          harness.provider.saveTokens({
            access_token: "late-token",
            token_type: "bearer",
          }),
        ).rejects.toThrow("authentication was cleared");
        const login = await harness.upstream.initiateOAuthForServer("docs");
        expect(new URL(login.authorizationUrl).pathname).toBe("/login");
        expect(harness.sessions.getOAuthFlow(login.state)).toBeDefined();
      } finally {
        await harness.upstream.shutdown();
        harness.resolver.shutdown();
        harness.state.stopRetentionSweep();
      }
    },
  );

  it("rejects an old device-flow completion after a description edit and logout", async () => {
    const harness = await makeHarness();
    let onComplete!: (client: ExtendedClientI) => void | Promise<void>;
    jest
      .spyOn(harness.oauth, "initiateOAuth")
      .mockImplementation(async (_target, options) => {
        if (!options?.onComplete)
          throw new Error("Missing completion callback");
        onComplete = options.onComplete;
        return {
          authorizationUrl: "https://example.com/login",
          state: "old-state",
        };
      });
    try {
      await harness.upstream.initiateOAuthForServer("docs");
      harness.upstream.updateClientDescription("docs", "Updated description");
      await harness.upstream.logoutOAuthForServer("docs");
      await expect(
        onComplete(harness.extended as unknown as ExtendedClientI),
      ).rejects.toThrow("was logged out");
      expect(harness.resolver.resolveToolCall("docs__read", {}).ok).toBe(false);
      expect(harness.state.export().targetServers[0]?.state).toEqual({
        type: "pending-auth",
      });
    } finally {
      await harness.upstream.shutdown();
      harness.resolver.shutdown();
      harness.state.stopRetentionSweep();
    }
  });

  it("reports deletion failures and permits retry without reconnecting", async () => {
    const harness = await makeHarness();
    const deletion = jest
      .spyOn(harness.store, "deleteAll")
      .mockRejectedValue(new Error("Unable to delete credentials"));
    try {
      await expect(
        harness.upstream.logoutOAuthForServer("docs"),
      ).rejects.toThrow("Unable to delete credentials");
      expect(harness.resolver.resolveToolCall("docs__read", {}).ok).toBe(false);
      deletion.mockRestore();
      await harness.upstream.logoutOAuthForServer("docs");
      expect(await fs.readdir(directory)).toEqual([]);
    } finally {
      await harness.upstream.shutdown();
      harness.resolver.shutdown();
      harness.state.stopRetentionSweep();
    }
  });

  it.each(["close", "persistence", "token deletion"] as const)(
    "returns a management tool error when strict removal fails during %s",
    async (failure) => {
      const harness = await makeHarness();
      try {
        if (failure === "close") {
          harness.extended.close.mockRejectedValue(
            new Error("Unable to close connection"),
          );
        } else if (failure === "persistence") {
          harness.writeConfig.mockImplementation(() => {
            throw new Error("Unable to persist server configuration");
          });
        } else {
          jest
            .spyOn(harness.store, "deleteAll")
            .mockRejectedValue(new Error("Unable to delete credentials"));
        }

        const response = await callManagementAction(harness);
        expect(response.isError).toBe(true);
        expect(getToolResponseJson(response as never)).not.toHaveProperty(
          "removed",
          true,
        );
        expect(harness.upstream.servers).toHaveLength(1);
        expect(harness.upstream.servers).toHaveLength(1);
      } finally {
        await harness.upstream.shutdown();
        harness.resolver.shutdown();
        harness.state.stopRetentionSweep();
      }
    },
  );

  it.each(["docs", "Docs"] as const)(
    "confirms management removal and clears credentials for configured name %s",
    async (serverName) => {
      const harness = await makeHarness(serverName);
      const deleteTokens = jest.spyOn(
        harness.oauth,
        "deleteOAuthTokensForServer",
      );
      try {
        const response = await callManagementAction(harness);
        expect(response.isError).toBeUndefined();
        expect(getToolResponseJson(response as never)).toEqual({
          name: "docs",
          removed: true,
        });
        expect(deleteTokens).toHaveBeenCalledWith(serverName);
        expect(harness.upstream.servers).toEqual([]);
        expect(await fs.readdir(directory)).toEqual([]);
      } finally {
        await harness.upstream.shutdown();
        harness.resolver.shutdown();
        harness.state.stopRetentionSweep();
      }
    },
  );

  it("keeps legacy best-effort removal when OAuth token deletion fails", async () => {
    const harness = await makeHarness();
    jest
      .spyOn(harness.store, "deleteAll")
      .mockRejectedValue(new Error("Unable to delete credentials"));
    try {
      await expect(
        harness.upstream.removeClient("docs"),
      ).resolves.toBeUndefined();
      expect(harness.upstream.servers).toEqual([]);
      expect(harness.writeConfig).toHaveBeenLastCalledWith([]);
    } finally {
      await harness.upstream.shutdown();
      harness.resolver.shutdown();
      harness.state.stopRetentionSweep();
    }
  });

  it("can log out after an unrelated configuration update rebuilds provider caches", async () => {
    const harness = await makeHarness();
    try {
      await harness.sessions.prepareConfig(DEFAULT_CONFIG);
      await harness.sessions.commitConfig();
      expect(harness.sessions.getExistingOAuthProvider("docs")).toBeUndefined();
      expect(harness.upstream.isOAuthServer("docs")).toBe(true);
      await harness.upstream.logoutOAuthForServer("docs");
      expect(await fs.readdir(directory)).toEqual([]);
    } finally {
      await harness.upstream.shutdown();
      harness.resolver.shutdown();
      harness.state.stopRetentionSweep();
    }
  });

  it("blocks dispatch if the server is disabled while token inspection is pending", async () => {
    const harness = await makeHarness();
    let release!: () => void;
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.spyOn(harness.provider, "tokens").mockImplementation(async () => {
      start();
      await gate;
      return { access_token: "old-token", token_type: "bearer" };
    });
    try {
      const call = harness.upstream.callTool("docs", { name: "read" });
      await started;
      await harness.config.withLock(() =>
        harness.config.updateConfig({
          ...DEFAULT_CONFIG,
          targetServerAttributes: { docs: { inactive: true } },
        }),
      );
      const rejected = expect(call).rejects.toThrow("inactive");
      release();
      await rejected;
      expect(harness.extended.callTool).not.toHaveBeenCalled();
    } finally {
      release();
      await harness.upstream.shutdown();
      harness.resolver.shutdown();
      harness.state.stopRetentionSweep();
    }
  });
});
