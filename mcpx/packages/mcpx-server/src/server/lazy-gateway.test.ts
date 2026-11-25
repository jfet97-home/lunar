import { createServer, Server as HttpServer } from "node:http";
import path from "node:path";
import express, { RequestHandler } from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ElicitRequest,
  ElicitRequestSchema,
  ElicitResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { noOpLogger } from "@aigw/core/logging";
import { McpxSession } from "../model/sessions.js";
import { BehaviorSetting } from "../services/behavior-service.js";
import { Services } from "../services/services.js";
import { ManagementToolsService } from "../services/management-tools.js";
import {
  InternalCapabilitiesService,
  wireInternalCapabilityProvider,
} from "../services/internal-capabilities-service.js";
import { CapabilityRegistry } from "../services/capability-registry.js";
import { PermissionCheck } from "../services/capability-resolver.js";
import { CodeModeService } from "../code-mode/service.js";
import { DEFAULT_CODE_MODE_LIMITS } from "../code-mode/policy.js";

let buildDownstreamTransportsRouter: (typeof import("./downstream-transports.js"))["buildDownstreamTransportsRouter"];

jest.mock("../services/local-tool-search.js", () => ({
  LocalToolSearch: class {
    // an exact name, else every description containing the query, in catalog order
    async search(tools: Tool[], query: string): Promise<Tool[]> {
      const lower = query.toLowerCase();
      const exact = tools.filter((tool) => tool.name.toLowerCase() === lower);
      return exact.length > 0
        ? exact
        : tools.filter((tool) =>
            (tool.description ?? "").toLowerCase().includes(lower),
          );
    }
  },
}));

interface ToolEntry {
  serverName: string;
  capabilityName: string;
  definition: Tool;
  origin: "internal" | "upstream";
}

interface HarnessOptions {
  descriptionsByName?: Record<string, string>;
  serverInfoByName?: Record<
    string,
    NonNullable<ReturnType<Client["getServerVersion"]>>
  >;
  catalog?: { id: string; name: string; description?: string }[];
  catalogIds?: Record<string, string>;
  pendingAuthServers?: Set<string>;
  serverNames?: string[];
  entries?: ToolEntry[];
  deniedNames?: Set<string>;
  inactiveServers?: Set<string>;
  hiddenNames?: Set<string>;
  cacheEnabled?: boolean;
  persistedSessions?: Map<string, McpxSession["metadata"]>;
  toolResult?: unknown;
  onCallTool?: (...args: unknown[]) => Promise<unknown>;
  authVersions?: Map<string, number>;
  codeMode?: CodeModeService;
  management?: {
    services: Pick<
      Services,
      | "controlPlane"
      | "upstreamHandler"
      | "setupManager"
      | "localSavedSetups"
      | "localExportService"
      | "hubService"
    >;
    permissions: PermissionCheck;
  };
}

interface Harness {
  baseUrl: string;
  server: HttpServer;
  sessions: Map<string, McpxSession>;
  upstreamCallTool: jest.Mock;
  auditLog: jest.Mock;
  systemStateTracker: {
    recordToolCall: jest.Mock;
  };
  services: Services;
  entries: ToolEntry[];
  connectClient: (
    path: "/mcp" | "/mcp/lazy",
    authorization?: string,
    options?: { elicit?: (request: ElicitRequest) => Promise<ElicitResult> },
  ) => Promise<{
    client: Client;
    transport: StreamableHTTPClientTransport;
  }>;
  close: () => Promise<void>;
  revokeTool: (name: string) => void;
}

const ALLOWED_NAME = "docs__get_page";
const DENIED_NAME = "secrets__read";
const INACTIVE_NAME = "legacy__fetch";
const HIDDEN_NAME = "oauth__grant";

function makeTool(name: string, description = `Read ${name}`): Tool {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  };
}

function makeEntry(
  serverName: string,
  capabilityName: string,
  name: string,
  origin: ToolEntry["origin"] = "upstream",
): ToolEntry {
  return { serverName, capabilityName, definition: makeTool(name), origin };
}

function makeMetadata(): McpxSession["metadata"] {
  return {
    clientId: "restored-client",
    clientInfo: { name: "test-client", protocolVersion: "2025-11-25" },
    isProbe: false,
  };
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const entries = [
    ...(options.entries ?? [
      makeEntry("docs", "get_page", ALLOWED_NAME),
      makeEntry("secrets", "read", DENIED_NAME),
      makeEntry("legacy", "fetch", INACTIVE_NAME),
      makeEntry("oauth", "grant", HIDDEN_NAME, "internal"),
    ]),
  ];
  const deniedNames = options.deniedNames ?? new Set([DENIED_NAME]);
  const inactiveServers = options.inactiveServers ?? new Set(["legacy"]);
  const hiddenNames = options.hiddenNames ?? new Set([HIDDEN_NAME]);
  const persistedSessions = options.persistedSessions ?? new Map();
  const sessions = new Map<string, McpxSession>();
  const auditLog = jest.fn();
  const recordToolCall = jest.fn();
  const upstreamCallTool = jest.fn(
    options.onCallTool ?? (async () => options.toolResult ?? { content: [] }),
  );
  const sessionsService = {
    addSession: async (
      sessionId: string,
      session: McpxSession,
    ): Promise<void> => {
      sessions.set(sessionId, session);
    },
    getSession: (sessionId: string): McpxSession | undefined =>
      sessions.get(sessionId),
    getConsumerContext: (sessionId: string | undefined) => {
      const session = sessionId ? sessions.get(sessionId) : undefined;
      return {
        sessionId,
        consumerTag: session?.metadata.consumerTag,
        clientName: session?.metadata.clientInfo.name,
      };
    },
    updateSessionMetadata: (
      sessionId: string,
      metadata: McpxSession["metadata"],
    ): void => {
      const session = sessions.get(sessionId);
      if (session) session.metadata = metadata;
    },
    touchSession: jest.fn(),
    markSessionUnresponsive: jest.fn(),
    closeSession: async (sessionId: string): Promise<void> => {
      sessions.delete(sessionId);
    },
    loadPersistedDownstreamSession: async (sessionId: string) => {
      const metadata = persistedSessions.get(sessionId);
      return metadata ? { metadata } : undefined;
    },
  };
  const internalCapabilities = options.management
    ? new InternalCapabilitiesService(noOpLogger)
    : undefined;
  if (options.management && internalCapabilities) {
    const registry = new CapabilityRegistry(noOpLogger);
    const provider = new ManagementToolsService(
      options.management.services,
      options.management.permissions,
      () => false,
      "http://localhost:9523/auth/callback",
      noOpLogger,
    );
    wireInternalCapabilityProvider(provider, internalCapabilities, registry);
    for (const tool of registry.servers.get("mcpx")?.tools ?? []) {
      entries.push({
        serverName: "mcpx",
        capabilityName: tool.definition.name,
        definition: {
          ...tool.definition,
          name: `mcpx__${tool.definition.name}`,
        },
        origin: "internal",
      });
    }
  }
  const services = {
    sessions: sessionsService,
    behaviorService: {
      get: (setting: BehaviorSetting): boolean =>
        setting === BehaviorSetting.ENABLE_TOOL_CALL_CACHE &&
        (options.cacheEnabled ?? false),
    },
    capabilityResolver: {
      getPermittedTools: () =>
        entries.filter(
          (entry) =>
            !inactiveServers.has(entry.serverName) &&
            !deniedNames.has(entry.definition.name),
        ),
      resolveToolCall: (name: string) => {
        const entry = entries.find(
          (candidate) => candidate.definition.name === name,
        );
        if (!entry) return { ok: false as const, reason: "unknown" as const };
        if (inactiveServers.has(entry.serverName)) {
          return { ok: false as const, reason: "server-inactive" as const };
        }
        if (deniedNames.has(name)) {
          return { ok: false as const, reason: "permission-denied" as const };
        }
        return { ok: true as const, entry };
      },
    },
    internalCapabilities: internalCapabilities ?? {
      visibleToolForListing: (entry: ToolEntry) =>
        hiddenNames.has(entry.definition.name) ? undefined : entry.definition,
      dispatchTool: jest.fn(async () => ({ content: [] })),
      visiblePromptForListing: jest.fn(),
      visibleResourceForListing: jest.fn(),
    },
    upstreamHandler: {
      getAuthVersion: (name: string) => options.authVersions?.get(name) ?? 0,
      clientsByService: new Map(
        [
          ...new Set(
            options.serverNames ?? entries.map((entry) => entry.serverName),
          ),
        ].map((name) => [
          name,
          {
            _state: options.pendingAuthServers?.has(name)
              ? "pending-auth"
              : "connected",
            targetServer: {
              name,
              type: "streamable-http",
              url: "https://example.com/mcp",
              catalogItemId: options.catalogIds?.[name],
              description: options.descriptionsByName?.[name],
            },
            extendedClient: { serverInfo: options.serverInfoByName?.[name] },
          },
        ]),
      ),
      callTool: upstreamCallTool,
      getPrompt: jest.fn(),
    },
    systemStateTracker: {
      trackActiveCall: async <T>(action: () => Promise<T>): Promise<T> =>
        action(),
      recordToolCall,
      recordPromptGet: jest.fn(),
    },
    auditLog: { log: auditLog },
    metricRecorder: { recordToolCallDuration: jest.fn() },
    hubService: { recordToolCall: jest.fn() },
    catalogManager: { getCatalog: () => options.catalog ?? [] },
    codeMode: options.codeMode ?? { available: false },
  } as unknown as Services;

  const app = express();
  app.use(express.json());
  const allowRequests: RequestHandler = (_request, _response, next) => next();
  app.use(buildDownstreamTransportsRouter(allowRequests, services, noOpLogger));
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP listening address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const clients: Client[] = [];

  return {
    baseUrl,
    server,
    sessions,
    upstreamCallTool,
    auditLog,
    systemStateTracker: { recordToolCall },
    services,
    entries,
    connectClient: async (
      path,
      authorization = "Bearer test-token",
      clientOptions = {},
    ) => {
      const { elicit } = clientOptions;
      const client = new Client(
        { name: "gateway-test", version: "1.0.0" },
        elicit ? { capabilities: { elicitation: { form: {} } } } : undefined,
      );
      if (elicit) {
        client.setRequestHandler(ElicitRequestSchema, (request) =>
          elicit(request),
        );
      }
      const transport = new StreamableHTTPClientTransport(
        new URL(path, baseUrl),
        {
          requestInit: {
            headers: {
              Authorization: authorization,
              "x-lunar-consumer-tag": "test-consumer",
            },
          },
        },
      );
      await client.connect(transport);
      clients.push(client);
      return { client, transport };
    },
    close: async () => {
      await Promise.all(
        clients.map((client) => client.close().catch(() => {})),
      );
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
    revokeTool: (name) => deniedNames.add(name),
  };
}

function resultText(result: unknown): string {
  if (
    typeof result !== "object" ||
    result === null ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    throw new Error("Expected a content result from the discovery tool");
  }
  const block = result.content.find(
    (content: unknown) =>
      typeof content === "object" &&
      content !== null &&
      "type" in content &&
      content["type"] === "text",
  );
  if (
    typeof block !== "object" ||
    block === null ||
    !("text" in block) ||
    typeof block["text"] !== "string"
  ) {
    throw new Error("Expected a text result from the discovery tool");
  }
  return block["text"];
}

describe("lazy Streamable HTTP gateway", () => {
  const previousVersion = process.env["VERSION"];
  const previousInstanceId = process.env["INSTANCE_ID"];

  beforeAll(async () => {
    process.env["VERSION"] = "test";
    process.env["INSTANCE_ID"] = "test-instance";
    ({ buildDownstreamTransportsRouter } = await import(
      "./downstream-transports.js"
    ));
  });

  afterAll(() => {
    if (previousVersion === undefined) delete process.env["VERSION"];
    else process.env["VERSION"] = previousVersion;
    if (previousInstanceId === undefined) delete process.env["INSTANCE_ID"];
    else process.env["INSTANCE_ID"] = previousInstanceId;
  });

  it("keeps the full catalog endpoint and advertises four lazy discovery tools with startup guidance", async () => {
    const entries = Array.from({ length: 233 }, (_, index) =>
      makeEntry("docs", `tool_${index}`, `docs__tool_${index}`),
    );
    const harness = await makeHarness({ entries });
    try {
      const catalog = await harness.connectClient("/mcp");
      const lazy = await harness.connectClient("/mcp/lazy");

      expect((await catalog.client.listTools()).tools).toHaveLength(233);
      expect(
        (await lazy.client.listTools()).tools.map((tool) => tool.name),
      ).toEqual([
        "mcpx_list_servers",
        "mcpx_search_tools",
        "mcpx_get_tool_schema",
        "mcpx_call_tool",
      ]);
      expect(lazy.client.getInstructions()).toContain(
        "call mcpx_list_servers immediately",
      );
      expect(catalog.client.getInstructions()).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it.each(["/mcp", "/mcp/lazy"] as const)(
    "serves built-in management tools over %s through the real internal provider",
    async (endpoint) => {
      const addTargetServer = jest.fn().mockResolvedValue(undefined);
      const managementServices = {
        controlPlane: {
          addTargetServer,
          updateTargetServer: jest.fn(),
          removeTargetServer: jest.fn(),
          getSystemState: () => ({ targetServers: [] }),
          getAppConfig: () => ({ yaml: "" }),
          config: {
            getTargetServerAttributes: () => ({}),
            activateTargetServer: jest.fn(),
            deactivateTargetServer: jest.fn(),
          },
        },
        upstreamHandler: {
          servers: [],
          getTargetServer: jest.fn(),
          initiateOAuthForServer: jest.fn(),
          logoutOAuthForServer: jest.fn(),
        },
        setupManager: { captureCurrentSetup: jest.fn() },
        localSavedSetups: { save: jest.fn() },
        localExportService: { create: jest.fn() },
        hubService: { savedSetups: { saveSetup: jest.fn() } },
      } as unknown as NonNullable<HarnessOptions["management"]>["services"];
      let logoutAllowed = true;
      const permissions = {
        hasPermission: jest.fn(
          ({ capabilityName }) =>
            capabilityName !== "management_logout_server" || logoutAllowed,
        ),
      };
      const harness = await makeHarness({
        management: { services: managementServices, permissions },
      });
      try {
        const { client } = await harness.connectClient(endpoint);
        if (endpoint === "/mcp") {
          let names = (await client.listTools()).tools.map((tool) => tool.name);
          expect(names).toContain("mcpx__management_add_server");
          expect(names).toContain("mcpx__management_logout_server");
          logoutAllowed = false;
          names = (await client.listTools()).tools.map((tool) => tool.name);
          expect(names).not.toContain("mcpx__management_logout_server");
        } else {
          let lazyTools = (await client.listTools()).tools;
          expect(lazyTools).toHaveLength(15);
          expect(lazyTools.map((tool) => tool.name)).toContain(
            "mcpx__management_refresh_server",
          );
          expect(lazyTools.map((tool) => tool.name)).toContain(
            "mcpx__management_logout_server",
          );
          logoutAllowed = false;
          lazyTools = (await client.listTools()).tools;
          expect(lazyTools).toHaveLength(14);
          expect(lazyTools.map((tool) => tool.name)).toContain(
            "mcpx__management_add_server",
          );
          expect(lazyTools.map((tool) => tool.name)).not.toContain(
            "mcpx__management_logout_server",
          );
          expect(lazyTools.map((tool) => tool.name)).toContain(
            "mcpx_call_tool",
          );
          expect(client.getInstructions()).toContain(
            "management tools directly by their mcpx__management_* names",
          );
          const servers = JSON.parse(
            resultText(
              await client.callTool({
                name: "mcpx_list_servers",
                arguments: {},
              }),
            ),
          );
          expect(
            servers.servers.map((server: { name: string }) => server.name),
          ).toContain("mcpx");
          const search = JSON.parse(
            resultText(
              await client.callTool({
                name: "mcpx_search_tools",
                arguments: { query: "mcpx__management_add_server" },
              }),
            ),
          );
          expect(
            search.tools.map((tool: { name: string }) => tool.name),
          ).toContain("mcpx__management_add_server");
          expect(
            search.tools.map((tool: { name: string }) => tool.name),
          ).not.toContain("mcpx__management_logout_server");
          const schema = JSON.parse(
            resultText(
              await client.callTool({
                name: "mcpx_get_tool_schema",
                arguments: { name: "mcpx__management_add_server" },
              }),
            ),
          );
          expect(schema.inputSchema.required).toEqual(["name", "config"]);
        }

        const call =
          endpoint === "/mcp" || endpoint === "/mcp/lazy"
            ? await client.callTool({
                name: "mcpx__management_add_server",
                arguments: {
                  name: " Notes ",
                  config: { type: "sse", url: "https://notes.example/mcp" },
                },
              })
            : await client.callTool({
                name: "mcpx_call_tool",
                arguments: {
                  name: "mcpx__management_add_server",
                  arguments: {
                    name: " Notes ",
                    config: { type: "sse", url: "https://notes.example/mcp" },
                  },
                },
              });
        expect(call.isError).toBeFalsy();
        expect(addTargetServer).toHaveBeenCalledWith({
          name: "notes",
          type: "sse",
          url: "https://notes.example/mcp",
        });
        expect(harness.upstreamCallTool).not.toHaveBeenCalled();

        const hiddenName = "mcpx__management_logout_server";
        const hiddenCall =
          endpoint === "/mcp" || endpoint === "/mcp/lazy"
            ? client.callTool({
                name: hiddenName,
                arguments: { name: "notes" },
              })
            : client.callTool({
                name: "mcpx_call_tool",
                arguments: { name: hiddenName, arguments: { name: "notes" } },
              });
        if (endpoint === "/mcp") {
          await expect(hiddenCall).rejects.toThrow(/not available/i);
        } else {
          const response = await hiddenCall;
          expect(response.isError).toBe(true);
          expect(resultText(response)).toMatch(/permitted/i);
        }
        expect(
          managementServices.upstreamHandler.logoutOAuthForServer,
        ).not.toHaveBeenCalled();
      } finally {
        await harness.close();
      }
    },
  );

  it("rechecks management permissions after listing and schema lookup", async () => {
    let logoutAllowed = true;
    const logoutOAuthForServer = jest.fn();
    const managementServices = {
      controlPlane: {
        addTargetServer: jest.fn(),
        updateTargetServer: jest.fn(),
        removeTargetServer: jest.fn(),
        getSystemState: () => ({ targetServers: [] }),
        getAppConfig: () => ({ yaml: "" }),
        config: {
          getTargetServerAttributes: () => ({}),
          activateTargetServer: jest.fn(),
          deactivateTargetServer: jest.fn(),
        },
      },
      upstreamHandler: {
        servers: [],
        getTargetServer: jest.fn(),
        initiateOAuthForServer: jest.fn(),
        logoutOAuthForServer,
      },
      setupManager: { captureCurrentSetup: jest.fn() },
      localSavedSetups: { save: jest.fn() },
      localExportService: { create: jest.fn() },
      hubService: { savedSetups: { saveSetup: jest.fn() } },
    } as unknown as NonNullable<HarnessOptions["management"]>["services"];
    const permissions = {
      hasPermission: jest.fn(
        ({ capabilityName }) =>
          capabilityName !== "management_logout_server" || logoutAllowed,
      ),
    };
    const harness = await makeHarness({
      management: { services: managementServices, permissions },
      cacheEnabled: true,
    });
    try {
      const { client } = await harness.connectClient("/mcp/lazy");
      const toolName = "mcpx__management_logout_server";
      const listed = (await client.listTools()).tools.map((tool) => tool.name);
      expect(listed).toContain(toolName);
      const schema = JSON.parse(
        resultText(
          await client.callTool({
            name: "mcpx_get_tool_schema",
            arguments: { name: toolName },
          }),
        ),
      );
      expect(schema.name).toBe(toolName);
      logoutAllowed = false;
      expect(
        (await client.listTools()).tools.map((tool) => tool.name),
      ).not.toContain(toolName);
      const deniedCall = await client.callTool({
        name: toolName,
        arguments: { name: "docs" },
      });
      expect(deniedCall.isError).toBe(true);
      expect(logoutOAuthForServer).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("does not directly advertise or dispatch spoofed and dynamic internal tools", async () => {
    const spoofedName = "mcpx__management_add_server";
    const dynamicName = "dynamic__runtime_tool";
    const harness = await makeHarness({
      entries: [
        makeEntry("docs", "management_add_server", spoofedName, "upstream"),
        makeEntry("dynamic", "runtime_tool", dynamicName, "internal"),
      ],
      deniedNames: new Set(),
      inactiveServers: new Set(),
      hiddenNames: new Set(),
    });
    try {
      const { client } = await harness.connectClient("/mcp/lazy");
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual([
        "mcpx_list_servers",
        "mcpx_search_tools",
        "mcpx_get_tool_schema",
        "mcpx_call_tool",
      ]);
      for (const name of [spoofedName, dynamicName]) {
        const response = await client.callTool({ name, arguments: {} });
        expect(response.isError).toBe(true);
      }
      expect(harness.upstreamCallTool).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("does not replay cached management responses after state changes", async () => {
    let inactive = false;
    const server = {
      name: "docs",
      type: "sse",
      url: "https://docs.example/mcp",
    };
    const managementServices = {
      controlPlane: {
        addTargetServer: jest.fn(),
        updateTargetServer: jest.fn(),
        removeTargetServer: jest.fn(),
        getSystemState: () => ({
          targetServers: [
            {
              ...server,
              _type: "sse",
              state: { type: "connected" },
              oauth: false,
            },
          ],
        }),
        getAppConfig: () => ({ yaml: "" }),
        config: {
          getTargetServerAttributes: () => ({ docs: { inactive } }),
          activateTargetServer: jest.fn(),
          deactivateTargetServer: jest.fn(),
        },
      },
      upstreamHandler: {
        servers: [server],
        getTargetServer: jest.fn(() => server),
        initiateOAuthForServer: jest.fn(),
        logoutOAuthForServer: jest.fn(),
      },
      setupManager: { captureCurrentSetup: jest.fn() },
      localSavedSetups: { save: jest.fn() },
      localExportService: { create: jest.fn() },
      hubService: { savedSetups: { saveSetup: jest.fn() } },
    } as unknown as NonNullable<HarnessOptions["management"]>["services"];
    const harness = await makeHarness({
      management: {
        services: managementServices,
        permissions: { hasPermission: () => true },
      },
      cacheEnabled: true,
    });
    try {
      const { client } = await harness.connectClient("/mcp/lazy");
      const request = {
        name: "mcpx__management_list_servers",
        arguments: {},
        _meta: { progressToken: "management-list" },
      };
      const first = JSON.parse(resultText(await client.callTool(request)));
      expect(first.servers[0].enabled).toBe(true);
      inactive = true;
      const second = JSON.parse(resultText(await client.callTool(request)));
      expect(second.servers[0].enabled).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("lists only servers with visible tools and rechecks permissions on each call", async () => {
    const harness = await makeHarness();
    try {
      const { client } = await harness.connectClient("/mcp/lazy");
      const list = async () =>
        JSON.parse(
          resultText(
            await client.callTool({
              name: "mcpx_list_servers",
              arguments: {},
            }),
          ),
        );
      expect(await list()).toEqual({ servers: [{ name: "docs" }] });
      harness.revokeTool(ALLOWED_NAME);
      expect(await list()).toEqual({ servers: [] });
      expect(harness.upstreamCallTool).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("uses configured descriptions first, then handshake and catalog descriptions, and omits missing descriptions", async () => {
    const entries = [
      makeEntry("docs", "read", "docs__read"),
      makeEntry("docs", "search", "docs__search"),
      makeEntry("alias", "read", "alias__read"),
      makeEntry("fallback", "read", "fallback__read"),
      makeEntry("custom", "read", "custom__read"),
      makeEntry("handshake", "read", "handshake__read"),
      makeEntry("missing", "read", "missing__read"),
      makeEntry("internal", "read", "internal__read", "internal"),
    ];
    const harness = await makeHarness({
      entries,
      serverNames: [
        "docs",
        "alias",
        "fallback",
        "custom",
        "handshake",
        "missing",
        "unused",
      ],
      descriptionsByName: {
        docs: " Configured documentation ",
        alias: "   ",
        custom: "Custom integration",
      },
      serverInfoByName: {
        docs: {
          name: "upstream-name",
          version: "1",
          description: " Upstream documentation ",
        },
        fallback: { name: "fallback", version: "1", description: "   " },
        handshake: {
          name: "handshake",
          version: "1",
          description: " Upstream handshake ",
        },
      },
      catalogIds: { alias: "catalog-alias" },
      catalog: [
        { id: "docs", name: "docs", description: "Catalog documentation" },
        {
          id: "catalog-alias",
          name: "original-name",
          description: "Catalog alias",
        },
        { id: "fallback", name: "Fallback", description: " Catalog fallback " },
      ],
    });
    try {
      const { client } = await harness.connectClient("/mcp/lazy");
      const result = await client.callTool({
        name: "mcpx_list_servers",
        arguments: {},
      });
      expect(JSON.parse(resultText(result))).toEqual({
        servers: [
          { name: "alias", description: "Catalog alias" },
          { name: "custom", description: "Custom integration" },
          { name: "docs", description: "Configured documentation" },
          { name: "fallback", description: "Catalog fallback" },
          { name: "handshake", description: "Upstream handshake" },
          { name: "missing" },
        ],
      });
      expect(harness.upstreamCallTool).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("includes a server awaiting authentication when its authentication tool is visible", async () => {
    const harness = await makeHarness({
      entries: [
        makeEntry(
          "oauth",
          "request_authentication_link",
          "oauth__request_authentication_link",
          "internal",
        ),
      ],
      pendingAuthServers: new Set(["oauth"]),
      catalog: [
        { id: "oauth", name: "oauth", description: "OAuth integration" },
      ],
    });
    try {
      const { client } = await harness.connectClient("/mcp/lazy");
      const result = await client.callTool({ name: "mcpx_list_servers" });
      expect(JSON.parse(resultText(result))).toEqual({
        servers: [{ name: "oauth", description: "OAuth integration" }],
      });
    } finally {
      await harness.close();
    }
  });

  it("discovers, forwards an authorized call, and preserves rich tool output", async () => {
    const toolResult = {
      content: [
        { type: "text", text: "Page 42" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        {
          type: "resource",
          resource: {
            uri: "file:///page.txt",
            mimeType: "text/plain",
            text: "body",
          },
        },
      ],
      structuredContent: { page: { id: "42", title: "Example" } },
      isError: true,
      _meta: { source: "upstream" },
    };
    const harness = await makeHarness({ toolResult });
    try {
      const { client } = await harness.connectClient(
        "/mcp/lazy",
        "Bearer caller-token",
      );
      const search = await client.callTool({
        name: "mcpx_search_tools",
        arguments: { query: ALLOWED_NAME },
      });
      expect(JSON.parse(resultText(search)).tools).toEqual([
        expect.objectContaining({ name: ALLOWED_NAME }),
      ]);

      const schema = await client.callTool({
        name: "mcpx_get_tool_schema",
        arguments: { name: ALLOWED_NAME },
      });
      expect(JSON.parse(resultText(schema))).toMatchObject({
        name: ALLOWED_NAME,
        inputSchema: expect.objectContaining({ required: ["id"] }),
      });

      const callMeta = { progressToken: "page-call-1", traceId: "trace-42" };
      const result = await client.callTool({
        name: "mcpx_call_tool",
        arguments: { name: ALLOWED_NAME, arguments: { id: "42" } },
        _meta: callMeta,
      });

      expect(result).toEqual(toolResult);
      expect(harness.upstreamCallTool).toHaveBeenCalledWith("docs", {
        name: "get_page",
        arguments: { id: "42" },
        _meta: { ...callMeta, authorization: "Bearer caller-token" },
      });
      expect(harness.systemStateTracker.recordToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          targetServerName: "docs",
          toolName: "get_page",
        }),
      );
      expect(harness.auditLog).toHaveBeenCalledWith({
        eventType: "tool_used",
        payload: expect.objectContaining({
          targetServerName: "docs",
          toolName: "get_page",
          args: { id: "42" },
          consumerTag: "test-consumer",
        }),
      });
    } finally {
      await harness.close();
    }
  });

  it("does not discover or execute denied, hidden, inactive, or unknown tools", async () => {
    const harness = await makeHarness();
    try {
      const { client } = await harness.connectClient("/mcp/lazy");
      for (const name of [
        DENIED_NAME,
        HIDDEN_NAME,
        INACTIVE_NAME,
        "missing__tool",
      ]) {
        const schema = await client.callTool({
          name: "mcpx_get_tool_schema",
          arguments: { name },
        });
        expect(schema.isError).toBe(true);
        expect(resultText(schema)).not.toContain(name);

        const call = await client.callTool({
          name: "mcpx_call_tool",
          arguments: { name, arguments: { id: "secret" } },
        });
        expect(call.isError).toBe(true);
        expect(resultText(call)).not.toContain(name);
      }

      expect(harness.upstreamCallTool).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("returns the full schema unchanged by default and a compact view on request, for visible tools only", async () => {
    const issue: ToolEntry = {
      serverName: "jira",
      capabilityName: "create_issue",
      origin: "upstream",
      definition: {
        name: "jira__create_issue",
        description: "Create a Jira issue",
        inputSchema: {
          type: "object",
          $defs: {
            Fields: {
              type: "object",
              properties: {
                labels: { type: "array", items: { type: "string" } },
              },
              additionalProperties: true,
            },
          },
          properties: {
            project: {
              type: "string",
              pattern: "^[A-Z]+$",
              description: "Project key",
            },
            type: { enum: ["Bug", "Task"] },
            fields: { $ref: "#/$defs/Fields" },
          },
          required: ["project", "type"],
        },
        outputSchema: {
          type: "object",
          properties: { key: { type: "string" } },
        },
        annotations: { destructiveHint: false },
      },
    };
    const harness = await makeHarness({
      entries: [
        makeEntry("docs", "get_page", ALLOWED_NAME),
        makeEntry("secrets", "read", DENIED_NAME),
        makeEntry("legacy", "fetch", INACTIVE_NAME),
        makeEntry("oauth", "grant", HIDDEN_NAME, "internal"),
        issue,
      ],
    });
    try {
      const { client } = await harness.connectClient("/mcp/lazy");
      const lookup = (args: Record<string, unknown>) =>
        client.callTool({ name: "mcpx_get_tool_schema", arguments: args });
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === "mcpx_get_tool_schema",
      );
      expect(advertised?.inputSchema.properties?.["format"]).toMatchObject({
        enum: ["full", "compact"],
        default: "full",
      });

      const full = await lookup({ name: issue.definition.name });
      expect(full.isError).toBeFalsy();
      expect(resultText(full)).toBe(JSON.stringify(issue.definition));
      expect(
        resultText(
          await lookup({ name: issue.definition.name, format: "full" }),
        ),
      ).toBe(resultText(full));

      const compact = await lookup({
        name: issue.definition.name,
        format: "compact",
      });
      expect(compact.isError).toBeFalsy();
      expect(JSON.parse(resultText(compact))).toEqual({
        name: "jira__create_issue",
        format: "compact",
        description: "Create a Jira issue",
        annotations: { destructiveHint: false },
        inputType:
          '{ /** Project key */ project: string; type: "Bug" | "Task"; fields?: { labels?: string[]; [key: string]: unknown } }',
        complete: false,
        omitted: ["pattern"],
      });
      expect(resultText(compact).length).toBeLessThan(resultText(full).length);

      const unavailable = resultText(await lookup({ name: "missing__tool" }));
      for (const name of [DENIED_NAME, HIDDEN_NAME, INACTIVE_NAME]) {
        const hidden = await lookup({ name, format: "compact" });
        expect(hidden.isError).toBe(true);
        expect(resultText(hidden)).toBe(unavailable);
      }
      const invalid = await lookup({ name: ALLOWED_NAME, format: "brief" });
      expect(invalid.isError).toBe(true);
      expect(harness.upstreamCallTool).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("reports read-only eligibility as unavailable when Code Mode is not available", async () => {
    const harness = await makeHarness();
    try {
      const { client } = await harness.connectClient("/mcp/lazy");
      const search = (readOnly?: boolean) =>
        client.callTool({
          name: "mcpx_search_tools",
          arguments: {
            query: ALLOWED_NAME,
            ...(readOnly === undefined ? {} : { readOnly }),
          },
        });
      const unfiltered = await search();
      expect(JSON.parse(resultText(unfiltered)).tools).toEqual([
        expect.objectContaining({
          name: ALLOWED_NAME,
          readOnlyEligibility: { eligible: false, reason: "unavailable" },
        }),
      ]);
      expect(resultText(await search(false))).toBe(resultText(unfiltered));
      const filtered = await search(true);
      expect(filtered.isError).toBe(true);
      expect(resultText(filtered)).toMatch(
        /mcpx_execute_readonly is not available/,
      );
    } finally {
      await harness.close();
    }
  });

  it("deduplicates concurrent calls and rechecks permissions before a cached replay", async () => {
    let releaseCall: ((value: unknown) => void) | undefined;
    let callStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      callStarted = resolve;
    });
    const pendingResult = new Promise<unknown>((resolve) => {
      releaseCall = resolve;
    });
    const harness = await makeHarness({
      cacheEnabled: true,
      onCallTool: async () => {
        callStarted?.();
        return pendingResult;
      },
    });
    try {
      const { client } = await harness.connectClient("/mcp/lazy");
      const params = {
        name: "mcpx_call_tool",
        arguments: { name: ALLOWED_NAME, arguments: { id: "42" } },
        _meta: { progressToken: "deduplicate-1" },
      };
      const first = client.callTool(params);
      await started;
      const second = client.callTool(params);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(harness.upstreamCallTool).toHaveBeenCalledTimes(1);

      const value = { content: [{ type: "text", text: "done" }] };
      releaseCall?.(value);
      await expect(Promise.all([first, second])).resolves.toEqual([
        value,
        value,
      ]);

      harness.revokeTool(ALLOWED_NAME);
      const replay = await client.callTool(params);
      expect(replay.isError).toBe(true);
      expect(harness.upstreamCallTool).toHaveBeenCalledTimes(1);
    } finally {
      releaseCall?.({ content: [] });
      await harness.close();
    }
  });

  it.each(["/mcp", "/mcp/lazy"] as const)(
    "rejects cached and new calls after disabling a server on %s without reconnecting",
    async (endpoint) => {
      const inactiveServers = new Set<string>();
      const harness = await makeHarness({
        cacheEnabled: true,
        inactiveServers,
      });
      try {
        const { client } = await harness.connectClient(endpoint);
        const params = {
          name: endpoint === "/mcp" ? ALLOWED_NAME : "mcpx_call_tool",
          arguments:
            endpoint === "/mcp"
              ? { id: "42" }
              : { name: ALLOWED_NAME, arguments: { id: "42" } },
          _meta: { progressToken: "disable-replay" },
        };
        await client.callTool(params);
        inactiveServers.add("docs");

        const expectUnavailable = async (request: typeof params) => {
          if (endpoint === "/mcp") {
            await expect(client.callTool(request)).rejects.toThrow(
              "server inactive",
            );
          } else {
            expect((await client.callTool(request)).isError).toBe(true);
          }
        };
        await expectUnavailable(params);
        await expectUnavailable({
          ...params,
          _meta: { progressToken: "disable-new" },
        });
        expect(harness.upstreamCallTool).toHaveBeenCalledTimes(1);

        if (endpoint === "/mcp") {
          expect(
            (await client.listTools()).tools.map((tool) => tool.name),
          ).not.toContain(ALLOWED_NAME);
        } else {
          expect(
            JSON.parse(
              resultText(
                await client.callTool({
                  name: "mcpx_list_servers",
                  arguments: {},
                }),
              ),
            ),
          ).not.toEqual(
            expect.objectContaining({
              servers: expect.arrayContaining([{ name: "docs" }]),
            }),
          );
          expect(
            (
              await client.callTool({
                name: "mcpx_get_tool_schema",
                arguments: { name: ALLOWED_NAME },
              })
            ).isError,
          ).toBe(true);
        }

        inactiveServers.delete("docs");
        await client.callTool({
          ...params,
          _meta: { progressToken: "reenabled" },
        });
        expect(harness.upstreamCallTool).toHaveBeenCalledTimes(2);
      } finally {
        await harness.close();
      }
    },
  );

  it("rejects a cached pending duplicate after disable without waiting for the original call", async () => {
    let releaseCall!: (value: unknown) => void;
    let callStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      callStarted = resolve;
    });
    const pendingResult = new Promise<unknown>((resolve) => {
      releaseCall = resolve;
    });
    const inactiveServers = new Set<string>();
    const harness = await makeHarness({
      cacheEnabled: true,
      inactiveServers,
      onCallTool: async () => {
        callStarted();
        return pendingResult;
      },
    });
    try {
      const { client } = await harness.connectClient("/mcp");
      const params = {
        name: ALLOWED_NAME,
        arguments: {},
        _meta: { progressToken: "disable-pending" },
      };
      const first = client.callTool(params);
      await started;
      inactiveServers.add("docs");
      await expect(
        client.callTool(params, undefined, { timeout: 1000 }),
      ).rejects.toThrow("server inactive");
      expect(harness.upstreamCallTool).toHaveBeenCalledTimes(1);
      releaseCall({ content: [] });
      await first;
    } finally {
      releaseCall({ content: [] });
      await harness.close();
    }
  });

  it.each(["/mcp", "/mcp/lazy"] as const)(
    "does not replay a previous account's cached result after fresh login on %s",
    async (endpoint) => {
      const authVersions = new Map<string, number>();
      const harness = await makeHarness({ cacheEnabled: true, authVersions });
      try {
        const { client } = await harness.connectClient(endpoint);
        const params = {
          name: endpoint === "/mcp" ? ALLOWED_NAME : "mcpx_call_tool",
          arguments:
            endpoint === "/mcp" ? {} : { name: ALLOWED_NAME, arguments: {} },
          _meta: { progressToken: "account-change" },
        };
        await client.callTool(params);
        authVersions.set("docs", 1);
        await client.callTool(params);
        expect(harness.upstreamCallTool).toHaveBeenCalledTimes(2);
        await client.callTool(params);
        expect(harness.upstreamCallTool).toHaveBeenCalledTimes(2);
      } finally {
        await harness.close();
      }
    },
  );

  it("rejects catalog sessions when addressed through the lazy endpoint", async () => {
    const harness = await makeHarness();
    try {
      const { transport } = await harness.connectClient("/mcp");
      const sessionId = transport.sessionId;
      if (!sessionId)
        throw new Error("Catalog client did not receive a session id");
      const headers = {
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId,
      };

      const post = await fetch(`${harness.baseUrl}/mcp/lazy`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      const get = await fetch(`${harness.baseUrl}/mcp/lazy`, {
        method: "GET",
        headers: { "Mcp-Session-Id": sessionId, Accept: "text/event-stream" },
      });
      const del = await fetch(`${harness.baseUrl}/mcp/lazy`, {
        method: "DELETE",
        headers: { "Mcp-Session-Id": sessionId },
      });

      expect([post.status, get.status, del.status]).toEqual([400, 400, 400]);
    } finally {
      await harness.close();
    }
  });

  it("restores only through the endpoint recorded on the persisted session", async () => {
    const metadata = { ...makeMetadata(), toolMode: "lazy" as const };
    const persistedSessions = new Map([["lazy-session", metadata]]);
    const harness = await makeHarness({ persistedSessions });
    try {
      const wrongMode = await fetch(`${harness.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Mcp-Session-Id": "lazy-session",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(wrongMode.status).toBe(400);

      const correctMode = await fetch(`${harness.baseUrl}/mcp/lazy`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Mcp-Session-Id": "lazy-session",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 2 }),
      });
      expect(correctMode.status).toBe(200);
      expect(harness.sessions.get("lazy-session")?.metadata.toolMode).toBe(
        "lazy",
      );
    } finally {
      await harness.close();
    }
  });
});

describe("Code Mode on the gateway endpoints", () => {
  jest.setTimeout(30_000);
  const runnerPath = path.resolve(process.cwd(), "src/code-mode/runner.ts");
  const WRITE_NAME = "tracker__create_issue";
  const previousVersion = process.env["VERSION"];
  const previousInstanceId = process.env["INSTANCE_ID"];

  beforeAll(async () => {
    process.env["VERSION"] = "test";
    process.env["INSTANCE_ID"] = "test-instance";
    ({ buildDownstreamTransportsRouter } = await import(
      "./downstream-transports.js"
    ));
  });

  afterAll(() => {
    if (previousVersion === undefined) delete process.env["VERSION"];
    else process.env["VERSION"] = previousVersion;
    if (previousInstanceId === undefined) delete process.env["INSTANCE_ID"];
    else process.env["INSTANCE_ID"] = previousInstanceId;
  });

  function codeMode(requireToolApproval = true): CodeModeService {
    return new CodeModeService(
      {
        enabled: true,
        requireToolApproval,
        runnerPath,
        limits: { ...DEFAULT_CODE_MODE_LIMITS, wallMs: 15_000 },
        trust: {
          // read-only mode counts only the exact names
          trustedReadTools: [
            "docs__*",
            "newsrv__*",
            ALLOWED_NAME,
            "newsrv__lookup",
          ],
          trustedAnnotationServers: [],
        },
      },
      noOpLogger,
    );
  }

  function entries(): ToolEntry[] {
    return [
      makeEntry("docs", "get_page", ALLOWED_NAME),
      makeEntry("tracker", "create_issue", WRITE_NAME),
      makeEntry("secrets", "read", DENIED_NAME),
      makeEntry("legacy", "fetch", INACTIVE_NAME),
      makeEntry("oauth", "grant", HIDDEN_NAME, "internal"),
    ];
  }

  async function execute(client: Client, code: string) {
    const result = await client.callTool({
      name: "mcpx_execute",
      arguments: { code },
    });
    return JSON.parse(resultText(result)) as {
      ok: boolean;
      result?: unknown;
      error?: { code: string };
      calls: Record<string, unknown>[];
    };
  }

  const approveOnce = (
    answers: ElicitResult[],
    seen: ElicitRequest[] = [],
    beforeAnswer: () => void = () => {},
  ) =>
    async function elicit(request: ElicitRequest): Promise<ElicitResult> {
      seen.push(request);
      beforeAnswer();
      return answers.shift() ?? { action: "decline" };
    };

  it("announces mcpx_execute in tools/list and instructions on both endpoints and keeps normal calls", async () => {
    const harness = await makeHarness({
      entries: entries(),
      codeMode: codeMode(),
    });
    try {
      const catalog = await harness.connectClient("/mcp");
      const lazy = await harness.connectClient("/mcp/lazy");
      const catalogNames = (await catalog.client.listTools()).tools.map(
        (tool) => tool.name,
      );
      expect(catalogNames).toEqual(
        expect.arrayContaining([ALLOWED_NAME, WRITE_NAME, "mcpx_execute"]),
      );
      expect(
        (await lazy.client.listTools()).tools.map((tool) => tool.name),
      ).toEqual([
        "mcpx_list_servers",
        "mcpx_search_tools",
        "mcpx_get_tool_schema",
        "mcpx_call_tool",
        "mcpx_execute",
        "mcpx_execute_readonly",
      ]);
      expect(catalogNames).toContain("mcpx_execute_readonly");
      for (const { client } of [catalog, lazy]) {
        const instructions = client.getInstructions();
        expect(instructions).toContain(
          "direct tool calls for a single small lookup",
        );
        expect(instructions).toContain(
          "a chain of calls or a large response you can filter, use mcpx_execute",
        );
        expect(instructions).toContain("use mcpx_execute_readonly");
        expect(instructions).toContain(
          "mcpx.searchTools(query, { readOnly: true })",
        );
        expect(instructions).toContain("Use loops and if statements");
        expect(instructions).toContain(
          "only call tools available through MCPX",
        );
        expect(instructions).toContain(
          "consider grouping related steps in a shell script",
        );
        const readOnlyTool = (await client.listTools()).tools.find(
          (tool) => tool.name === "mcpx_execute_readonly",
        );
        expect(readOnlyTool?.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
        });
        expect(readOnlyTool?.description).toContain("read_only_blocked");
      }
      expect(lazy.client.getInstructions()).toContain("mcpx_list_servers");

      await catalog.client.callTool({
        name: ALLOWED_NAME,
        arguments: { id: "direct" },
      });
      expect(harness.upstreamCallTool).toHaveBeenCalledWith(
        "docs",
        expect.objectContaining({
          name: "get_page",
          arguments: { id: "direct" },
        }),
      );
    } finally {
      await harness.close();
    }
  });

  it("chains discovery and calls through normal dispatch with the caller's identity and audit", async () => {
    const harness = await makeHarness({
      entries: entries(),
      codeMode: codeMode(),
      onCallTool: async (_server, params) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: (params as { arguments: { id: string } }).arguments.id,
              links: ["b", "c"],
            }),
          },
        ],
      }),
    });
    try {
      const { client } = await harness.connectClient(
        "/mcp/lazy",
        "Bearer caller-token",
      );
      const output = await execute(
        client,
        `
          const servers = await mcpx.listServers();
          const found = await mcpx.searchTools("${ALLOWED_NAME}");
          const schema = await mcpx.getToolSchema(found.tools[0].name);
          const root = await mcpx.callTool(schema.name, { id: "a" });
          const next = await mcpx.callTool(schema.name, { id: root.data.links[0] });
          return { servers: servers.servers.map((s) => s.name), ids: [root.data.id, next.data.id] };
        `,
      );
      expect(output.ok).toBe(true);
      expect(output.result).toEqual({
        servers: ["docs", "tracker"],
        ids: ["a", "b"],
      });
      expect(harness.upstreamCallTool).toHaveBeenCalledTimes(2);
      expect(harness.upstreamCallTool).toHaveBeenNthCalledWith(2, "docs", {
        name: "get_page",
        arguments: { id: "b" },
        _meta: { authorization: "Bearer caller-token" },
      });
      expect(harness.auditLog).toHaveBeenCalledWith({
        eventType: "tool_used",
        payload: expect.objectContaining({
          targetServerName: "docs",
          toolName: "get_page",
          args: { id: "b" },
          consumerTag: "test-consumer",
        }),
      });
      expect(harness.systemStateTracker.recordToolCall).toHaveBeenCalledTimes(
        2,
      );
    } finally {
      await harness.close();
    }
  });

  it.each(["/mcp", "/mcp/lazy"] as const)(
    "runs allowed writes without elicitation in client-managed mode on %s",
    async (endpoint) => {
      const harness = await makeHarness({
        entries: entries(),
        codeMode: codeMode(false),
      });
      try {
        const { client } = await harness.connectClient(endpoint);
        const output = await execute(
          client,
          `
            const write = await mcpx.callTool("${WRITE_NAME}", { title: "Mock write" });
            let denied;
            try { await mcpx.callTool("${DENIED_NAME}", {}); }
            catch (error) { denied = error.code; }
            return { write: write.isError, denied };
          `,
        );
        expect(output.result).toEqual({
          write: false,
          denied: "permission_denied",
        });
        expect(harness.upstreamCallTool).toHaveBeenCalledTimes(1);
        expect(harness.auditLog).toHaveBeenCalledWith({
          eventType: "tool_used",
          payload: expect.objectContaining({ toolName: "create_issue" }),
        });
      } finally {
        await harness.close();
      }
    },
  );

  it("asks the user per write and dispatches only the exact approved call", async () => {
    const harness = await makeHarness({
      entries: entries(),
      codeMode: codeMode(),
    });
    const seen: ElicitRequest[] = [];
    try {
      const { client } = await harness.connectClient("/mcp", undefined, {
        elicit: approveOnce(
          [{ action: "accept", content: { approve: true } }],
          seen,
        ),
      });
      const output = await execute(
        client,
        `
          const first = await mcpx.callTool("${WRITE_NAME}", { title: "Approved" });
          let second;
          try {
            await mcpx.callTool("${WRITE_NAME}", { title: "Approved" });
          } catch (error) {
            second = error.code;
          }
          return { first: first.isError, second };
        `,
      );
      expect(output.result).toEqual({
        first: false,
        second: "approval_declined",
      });
      expect(seen).toHaveLength(2);
      expect(seen[0]?.params.message).toContain(`Tool: ${WRITE_NAME}`);
      expect(seen[0]?.params.message).toContain('"title": "Approved"');
      expect(harness.upstreamCallTool).toHaveBeenCalledTimes(1);
      expect(harness.upstreamCallTool).toHaveBeenCalledWith("tracker", {
        name: "create_issue",
        arguments: { title: "Approved" },
        _meta: { authorization: "Bearer test-token" },
      });
    } finally {
      await harness.close();
    }
  });

  it("fails closed for clients without elicitation and for hidden, denied, inactive or wrapper tools", async () => {
    const harness = await makeHarness({
      entries: entries(),
      codeMode: codeMode(),
    });
    try {
      const { client } = await harness.connectClient("/mcp/lazy");
      const output = await execute(
        client,
        `
          const codes = [];
          for (const name of ["${WRITE_NAME}", "${DENIED_NAME}", "${INACTIVE_NAME}", "${HIDDEN_NAME}", "mcpx_execute", "mcpx_search_tools"]) {
            try { await mcpx.callTool(name, {}); } catch (error) { codes.push(error.code); }
          }
          const hidden = await mcpx.searchTools("${HIDDEN_NAME}");
          return { codes, hidden: hidden.totalMatches };
        `,
      );
      expect(output.result).toEqual({
        codes: [
          "approval_unsupported",
          "permission_denied",
          "server_inactive",
          "not_available",
          "recursion_blocked",
          "recursion_blocked",
        ],
        hidden: 0,
      });
      const wrapped = await client.callTool({
        name: "mcpx_call_tool",
        arguments: { name: "mcpx_execute", arguments: { code: "return 1" } },
      });
      expect(wrapped.isError).toBe(true);
      expect(harness.upstreamCallTool).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it.each([
    ["auth generation", "target_changed"],
    ["server target", "target_changed"],
  ])(
    "does not dispatch an approved call when its %s changed during approval",
    async (change, code) => {
      const authVersions = new Map<string, number>();
      const harness = await makeHarness({
        entries: entries(),
        codeMode: codeMode(),
        authVersions,
      });
      try {
        const mutate = (): void => {
          if (change === "auth generation") authVersions.set("tracker", 1);
          if (change === "server target") {
            const client =
              harness.services.upstreamHandler.clientsByService.get(
                "tracker",
              ) as unknown as { targetServer: { url: string } };
            client.targetServer = {
              ...client.targetServer,
              url: "https://replacement.example.com/mcp",
            };
          }
        };
        const { client } = await harness.connectClient("/mcp", undefined, {
          elicit: approveOnce(
            [{ action: "accept", content: { approve: true } }],
            [],
            mutate,
          ),
        });
        const output = await execute(
          client,
          `try { await mcpx.callTool("${WRITE_NAME}", { title: "x" }); } catch (error) { return error.code; }`,
        );
        expect(output.result).toBe(code);
        expect(harness.upstreamCallTool).not.toHaveBeenCalled();
      } finally {
        await harness.close();
      }
    },
  );

  it.each([
    ["closes", "session_closed"],
    ["changes its authorization", "identity_changed"],
  ])(
    "runs no further inner call after the calling session %s",
    async (change, code) => {
      const harness: Awaited<ReturnType<typeof makeHarness>> =
        await makeHarness({
          entries: entries(),
          codeMode: codeMode(),
          onCallTool: async () => {
            for (const [id, session] of harness.sessions) {
              if (change === "closes") harness.sessions.delete(id);
              else
                session.metadata = {
                  ...session.metadata,
                  authorization: "Bearer other",
                };
            }
            return { content: [{ type: "text", text: "{}" }] };
          },
        });
      try {
        const { client } = await harness.connectClient("/mcp");
        const output = await execute(
          client,
          `
            await mcpx.callTool("${ALLOWED_NAME}", { id: "1" });
            const codes = [];
            for (const run of [
              () => mcpx.callTool("${ALLOWED_NAME}", { id: "2" }),
              () => mcpx.searchTools("${ALLOWED_NAME}"),
            ]) {
              try { await run(); } catch (error) { codes.push(error.code); }
            }
            return codes;
          `,
        );
        expect(output.result).toEqual([code, code]);
        expect(harness.upstreamCallTool).toHaveBeenCalledTimes(1);
      } finally {
        await harness.close();
      }
    },
  );

  function readOnlyEntries(): ToolEntry[] {
    const annotated = (
      serverName: string,
      capabilityName: string,
      annotations: Tool["annotations"],
      origin: ToolEntry["origin"] = "upstream",
    ): ToolEntry => {
      const entry = makeEntry(
        serverName,
        capabilityName,
        `${serverName}__${capabilityName}`,
        origin,
      );
      return { ...entry, definition: { ...entry.definition, annotations } };
    };
    return [
      ...entries(),
      // an operator pattern lists it, but it declares a write
      annotated("docs", "delete_page", { destructiveHint: true }),
      // an upstream hint on a server the operator does not trust
      annotated("wiki", "read", { readOnlyHint: true }),
      annotated(
        "mcpx",
        "management_list_servers",
        { readOnlyHint: true },
        "internal",
      ),
    ];
  }

  const READ_ONLY_PROBE = `
    const codes = {};
    for (const name of [
      "${ALLOWED_NAME}", "${WRITE_NAME}", "docs__delete_page", "wiki__read",
      "mcpx__management_list_servers", "${DENIED_NAME}", "mcpx_execute",
    ]) {
      try { await mcpx.callTool(name, { id: "1" }); codes[name] = "ran"; } catch (error) { codes[name] = error.code; }
    }
    return codes;
  `;

  async function executeReadOnly(client: Client, code: string) {
    const result = await client.callTool({
      name: "mcpx_execute_readonly",
      arguments: { code },
    });
    return {
      isError: result.isError === true,
      output: JSON.parse(resultText(result)) as {
        ok: boolean;
        readOnly?: boolean;
        result?: unknown;
        calls: Record<string, unknown>[];
      },
    };
  }

  it.each([
    ["/mcp", false],
    ["/mcp/lazy", false],
    ["/mcp", true],
    ["/mcp/lazy", true],
  ] as const)(
    "mcpx_execute_readonly on %s (per-call approval %s) runs trusted reads only, without prompts",
    async (endpoint, requireToolApproval) => {
      const harness = await makeHarness({
        entries: readOnlyEntries(),
        codeMode: codeMode(requireToolApproval),
      });
      const seen: ElicitRequest[] = [];
      try {
        const { client } = await harness.connectClient(endpoint, undefined, {
          elicit: approveOnce(
            [{ action: "accept", content: { approve: true } }],
            seen,
          ),
        });
        const { output, isError } = await executeReadOnly(
          client,
          READ_ONLY_PROBE,
        );
        expect(isError).toBe(false);
        expect(output.readOnly).toBe(true);
        expect(output.result).toEqual({
          [ALLOWED_NAME]: "ran",
          [WRITE_NAME]: "read_only_blocked",
          docs__delete_page: "read_only_blocked",
          wiki__read: "read_only_blocked",
          mcpx__management_list_servers: "ran",
          [DENIED_NAME]: "permission_denied",
          mcpx_execute: "recursion_blocked",
        });
        expect(seen).toEqual([]);
        expect(harness.upstreamCallTool).toHaveBeenCalledTimes(1);
        expect(harness.upstreamCallTool).toHaveBeenCalledWith("docs", {
          name: "get_page",
          arguments: { id: "1" },
          _meta: { authorization: "Bearer test-token" },
        });
        expect(
          harness.services.internalCapabilities.dispatchTool,
        ).toHaveBeenCalledTimes(1);
        expect(output.calls).toEqual([
          expect.objectContaining({
            tool: ALLOWED_NAME,
            status: "succeeded",
            approval: "trusted_read",
          }),
          expect.objectContaining({
            tool: WRITE_NAME,
            status: "rejected",
            errorCode: "read_only_blocked",
          }),
          expect.objectContaining({
            tool: "docs__delete_page",
            errorCode: "read_only_blocked",
          }),
          expect.objectContaining({
            tool: "wiki__read",
            errorCode: "read_only_blocked",
          }),
          expect.objectContaining({
            tool: "mcpx__management_list_servers",
            status: "succeeded",
          }),
          expect.objectContaining({
            tool: DENIED_NAME,
            errorCode: "permission_denied",
          }),
        ]);
        expect(harness.auditLog).toHaveBeenCalledWith({
          eventType: "tool_used",
          payload: expect.objectContaining({
            toolName: "get_page",
            consumerTag: "test-consumer",
          }),
        });
      } finally {
        await harness.close();
      }
    },
  );

  it.each([false, true])(
    "keeps mcpx_execute's own policy beside the read-only tool (per-call approval %s)",
    async (requireToolApproval) => {
      const harness = await makeHarness({
        entries: readOnlyEntries(),
        codeMode: codeMode(requireToolApproval),
      });
      const seen: ElicitRequest[] = [];
      try {
        const { client } = await harness.connectClient("/mcp/lazy", undefined, {
          elicit: approveOnce(
            [{ action: "accept", content: { approve: true } }],
            seen,
          ),
        });
        const write = `try { await mcpx.callTool("${WRITE_NAME}", { title: "x" }); return "ran"; } catch (error) { return error.code; }`;
        expect((await executeReadOnly(client, write)).output.result).toBe(
          "read_only_blocked",
        );
        expect(seen).toHaveLength(0);
        expect((await execute(client, write)).result).toBe("ran");
        expect(seen).toHaveLength(requireToolApproval ? 1 : 0);
        expect(harness.upstreamCallTool).toHaveBeenCalledTimes(1);
        expect(harness.upstreamCallTool).toHaveBeenCalledWith(
          "tracker",
          expect.objectContaining({ name: "create_issue" }),
        );
        // neither tool reaches the other through a script or a wrapper
        expect(
          await execute(
            client,
            `try { await mcpx.callTool("mcpx_execute_readonly", { code: "return 1" }); } catch (error) { return error.code; }`,
          ),
        ).toMatchObject({ result: "recursion_blocked" });
        const wrapped = await client.callTool({
          name: "mcpx_call_tool",
          arguments: {
            name: "mcpx_execute_readonly",
            arguments: { code: "return 1" },
          },
        });
        expect(wrapped.isError).toBe(true);
      } finally {
        await harness.close();
      }
    },
  );

  it("does not let a wildcard admit a new annotation-less tool in read-only mode", async () => {
    const harness = await makeHarness({
      entries: readOnlyEntries(),
      codeMode: codeMode(true),
    });
    const seen: ElicitRequest[] = [];
    try {
      const { client } = await harness.connectClient("/mcp", undefined, {
        elicit: approveOnce([], seen),
      });
      // added after the session started; only the docs__* pattern matches it
      harness.entries.push(makeEntry("docs", "purge", "docs__purge"));
      const call = `try { await mcpx.callTool("docs__purge", { id: "1" }); return "ran"; } catch (error) { return error.code; }`;
      const readOnly = await executeReadOnly(client, call);
      expect(readOnly.output.result).toBe("read_only_blocked");
      expect(harness.upstreamCallTool).not.toHaveBeenCalled();
      // per-call approval keeps treating the pattern as trusted, as before
      const ordinary = await execute(client, call);
      expect(ordinary.result).toBe("ran");
      expect(ordinary.calls).toEqual([
        expect.objectContaining({ approval: "trusted_read" }),
      ]);
      expect(seen).toEqual([]);
      expect(harness.upstreamCallTool).toHaveBeenCalledTimes(1);
    } finally {
      await harness.close();
    }
  });

  it("re-checks identity and read-only trust on every inner call of the read-only tool", async () => {
    let calls = 0;
    const harness: Awaited<ReturnType<typeof makeHarness>> = await makeHarness({
      entries: readOnlyEntries(),
      codeMode: codeMode(false),
      onCallTool: async () => {
        calls += 1;
        if (calls === 1) {
          // the trusted read now declares a write
          const docs = harness.entries.find(
            (entry) => entry.definition.name === ALLOWED_NAME,
          );
          if (docs)
            docs.definition = {
              ...docs.definition,
              annotations: { readOnlyHint: false },
            };
        } else {
          for (const session of harness.sessions.values()) {
            session.metadata = {
              ...session.metadata,
              authorization: "Bearer other",
            };
          }
        }
        return { content: [{ type: "text", text: "{}" }] };
      },
    });
    try {
      harness.entries.push(makeEntry("newsrv", "lookup", "newsrv__lookup"));
      const { client } = await harness.connectClient("/mcp");
      const { output } = await executeReadOnly(
        client,
        `
          const codes = [];
          for (const name of ["${ALLOWED_NAME}", "${ALLOWED_NAME}", "newsrv__lookup", "newsrv__lookup"]) {
            try { await mcpx.callTool(name, { id: "1" }); codes.push("ran"); } catch (error) { codes.push(error.code); }
          }
          return codes;
        `,
      );
      expect(output.result).toEqual([
        "ran",
        "read_only_blocked",
        "ran",
        "identity_changed",
      ]);
      expect(harness.upstreamCallTool).toHaveBeenCalledTimes(2);
    } finally {
      await harness.close();
    }
  });

  it("reports in direct and script search the read-only decision that execution enforces", async () => {
    const notes = (
      serverName: string,
      capabilityName: string,
      annotations?: Tool["annotations"],
      origin: ToolEntry["origin"] = "upstream",
    ): ToolEntry => {
      const name = `${serverName}__${capabilityName}`;
      const definition = makeTool(name, `Notes tool ${name}`);
      return {
        serverName,
        capabilityName,
        origin,
        definition: annotations ? { ...definition, annotations } : definition,
      };
    };
    const harness = await makeHarness({
      // catalog order is the search ranking; an ineligible tool ranks first
      entries: [
        notes("tracker", "create_issue"),
        notes("docs", "get_page"),
        notes("docs", "delete_page", { destructiveHint: true }),
        notes("docs", "purge"),
        notes("kb", "read", { readOnlyHint: true }),
        notes("kb", "write", { readOnlyHint: false }),
        notes("wiki", "read", { readOnlyHint: true }),
        notes(
          "mcpx",
          "management_list_servers",
          { readOnlyHint: true },
          "internal",
        ),
        notes("secrets", "read"),
        notes("legacy", "fetch"),
        notes("oauth", "grant", undefined, "internal"),
      ],
      codeMode: new CodeModeService(
        {
          enabled: true,
          requireToolApproval: false,
          runnerPath,
          limits: { ...DEFAULT_CODE_MODE_LIMITS, wallMs: 15_000 },
          trust: {
            trustedReadTools: [
              ALLOWED_NAME,
              "docs__delete_page",
              "docs__*",
              // trust never makes denied, inactive or hidden tools visible
              DENIED_NAME,
              INACTIVE_NAME,
              HIDDEN_NAME,
            ],
            trustedAnnotationServers: ["kb"],
          },
        },
        noOpLogger,
      ),
    });
    const eligibility = {
      tracker__create_issue: { eligible: false, reason: "not_trusted" },
      // an exact entry trusts a tool without annotations
      [ALLOWED_NAME]: { eligible: true },
      docs__delete_page: { eligible: false, reason: "declares_write" },
      // a pattern is not enough
      docs__purge: { eligible: false, reason: "not_trusted" },
      kb__read: { eligible: true },
      kb__write: { eligible: false, reason: "declares_write" },
      wiki__read: { eligible: false, reason: "not_trusted" },
      mcpx__management_list_servers: { eligible: true },
    };
    const eligibleNames = [
      ALLOWED_NAME,
      "kb__read",
      "mcpx__management_list_servers",
    ];
    const search = async (client: Client, args: Record<string, unknown>) =>
      JSON.parse(
        resultText(
          await client.callTool({ name: "mcpx_search_tools", arguments: args }),
        ),
      ) as {
        tools: { name: string; readOnlyEligibility: unknown }[];
        totalMatches: number;
        nextOffset?: number;
      };
    const SCRIPT_SEARCH = `
      const unfiltered = await mcpx.searchTools("notes", { limit: 20 });
      const eligible = [];
      let offset = 0;
      do {
        const page = await mcpx.searchTools("notes", { limit: 2, offset, readOnly: true });
        eligible.push(...page.tools.map((tool) => tool.name));
        offset = page.nextOffset;
      } while (offset !== undefined);
    `;
    try {
      const { client } = await harness.connectClient("/mcp/lazy");
      const unfiltered = await search(client, { query: "notes", limit: 20 });
      expect(
        Object.fromEntries(
          unfiltered.tools.map((tool) => [tool.name, tool.readOnlyEligibility]),
        ),
      ).toEqual(eligibility);
      expect(unfiltered.tools.map((tool) => tool.name)).toEqual(
        Object.keys(eligibility),
      );
      expect(unfiltered.totalMatches).toBe(8);
      // upstream hints are passed through beside the gateway's decision
      expect(unfiltered.tools[5]).toMatchObject({
        name: "kb__write",
        annotations: { readOnlyHint: false },
      });
      for (const name of [DENIED_NAME, INACTIVE_NAME, HIDDEN_NAME]) {
        expect(JSON.stringify(unfiltered)).not.toContain(name);
      }
      expect(
        await search(client, { query: "notes", limit: 20, readOnly: false }),
      ).toEqual(unfiltered);

      expect(
        await search(client, { query: "notes", limit: 2, readOnly: true }),
      ).toEqual({
        tools: [
          expect.objectContaining({
            name: ALLOWED_NAME,
            readOnlyEligibility: { eligible: true },
          }),
          expect.objectContaining({ name: "kb__read" }),
        ],
        totalMatches: 3,
        nextOffset: 2,
      });
      expect(
        await search(client, {
          query: "notes",
          limit: 2,
          offset: 2,
          readOnly: true,
        }),
      ).toEqual({
        tools: [
          expect.objectContaining({ name: "mcpx__management_list_servers" }),
        ],
        totalMatches: 3,
      });
      for (const query of ["mcpx_execute_readonly", "mcpx_search_tools"]) {
        for (const readOnly of [false, true]) {
          expect(await search(client, { query, readOnly })).toEqual({
            tools: [],
            totalMatches: 0,
          });
        }
      }

      // scripts see the same decisions, and the read-only tool runs exactly them
      const ordinary = await execute(
        client,
        `${SCRIPT_SEARCH} return { unfiltered, eligible };`,
      );
      expect(ordinary.result).toEqual({
        unfiltered,
        eligible: eligibleNames,
      });
      for (const endpoint of ["/mcp", "/mcp/lazy"] as const) {
        const { client: scripted } = await harness.connectClient(endpoint);
        const { output } = await executeReadOnly(
          scripted,
          `
            ${SCRIPT_SEARCH}
            const ran = [];
            for (const tool of unfiltered.tools) {
              try { await mcpx.callTool(tool.name, { id: "1" }); ran.push(tool.name); }
              catch (error) { if (error.code !== "read_only_blocked") throw error; }
            }
            return { eligible, ran };
          `,
        );
        expect(output.result).toEqual({
          eligible: eligibleNames,
          ran: eligibleNames,
        });
      }

      // decisions follow the live definition
      const kbRead = harness.entries.find(
        (entry) => entry.definition.name === "kb__read",
      );
      if (!kbRead) throw new Error("expected kb__read");
      kbRead.definition = {
        ...kbRead.definition,
        annotations: { readOnlyHint: true, destructiveHint: true },
      };
      expect((await search(client, { query: "kb__read" })).tools).toEqual([
        expect.objectContaining({
          readOnlyEligibility: { eligible: false, reason: "declares_write" },
        }),
      ]);
    } finally {
      await harness.close();
    }
  });

  it.each([
    ["mcpx_execute", "/mcp"],
    ["mcpx_execute", "/mcp/lazy"],
    ["mcpx_execute_readonly", "/mcp"],
    ["mcpx_execute_readonly", "/mcp/lazy"],
  ] as const)(
    "serves full and compact schemas to %s scripts on %s with the normal visibility checks",
    async (toolName, endpoint) => {
      const harness = await makeHarness({
        entries: entries(),
        codeMode: codeMode(),
      });
      try {
        const { client } = await harness.connectClient(endpoint);
        harness.entries.push(makeEntry("newsrv", "lookup", "newsrv__lookup"));
        const result = await client.callTool({
          name: toolName,
          arguments: {
            code: `
              const full = await mcpx.getToolSchema("${ALLOWED_NAME}");
              const explicit = await mcpx.getToolSchema("${ALLOWED_NAME}", { format: "full" });
              const compact = await mcpx.getToolSchema("${ALLOWED_NAME}", { format: "compact" });
              const fresh = await mcpx.getToolSchema("newsrv__lookup", { format: "compact" });
              const errors = {};
              for (const [name, format] of [["${HIDDEN_NAME}", "compact"], ["${DENIED_NAME}", "compact"], ["${INACTIVE_NAME}", "compact"], ["${ALLOWED_NAME}", "ts"]]) {
                try { await mcpx.getToolSchema(name, { format }); } catch (error) { errors[name + ":" + format] = error.code; }
              }
              // the summary checks nothing; MCPX passes arguments as they are
              const call = await mcpx.callTool("${ALLOWED_NAME}", { id: 42 });
              return { full, explicit, compact, fresh, errors, called: !call.isError };
            `,
          },
        });
        const output = JSON.parse(resultText(result));
        expect(output.ok).toBe(true);
        expect(output.result).toEqual({
          full: makeTool(ALLOWED_NAME),
          explicit: makeTool(ALLOWED_NAME),
          compact: {
            name: ALLOWED_NAME,
            format: "compact",
            description: `Read ${ALLOWED_NAME}`,
            inputType: "{ id: string }",
            complete: true,
          },
          fresh: {
            name: "newsrv__lookup",
            format: "compact",
            description: "Read newsrv__lookup",
            inputType: "{ id: string }",
            complete: true,
          },
          errors: {
            [`${HIDDEN_NAME}:compact`]: "invalid_request",
            [`${DENIED_NAME}:compact`]: "invalid_request",
            [`${INACTIVE_NAME}:compact`]: "invalid_request",
            [`${ALLOWED_NAME}:ts`]: "invalid_request",
          },
          called: true,
        });
        expect(harness.upstreamCallTool).toHaveBeenCalledTimes(1);
        expect(harness.upstreamCallTool).toHaveBeenCalledWith(
          "docs",
          expect.objectContaining({
            name: "get_page",
            arguments: { id: 42 },
          }),
        );
      } finally {
        await harness.close();
      }
    },
  );

  it("reaches tools registered after the session started", async () => {
    const harness = await makeHarness({
      entries: entries(),
      codeMode: codeMode(),
    });
    try {
      const { client } = await harness.connectClient("/mcp/lazy");
      harness.entries.push(makeEntry("newsrv", "lookup", "newsrv__lookup"));
      const output = await execute(
        client,
        `
          const found = await mcpx.searchTools("newsrv__lookup");
          await mcpx.callTool(found.tools[0].name, { id: "1" });
          return found.tools.map((tool) => tool.name);
        `,
      );
      expect(output.result).toEqual(["newsrv__lookup"]);
      expect(harness.upstreamCallTool).toHaveBeenCalledWith(
        "newsrv",
        expect.objectContaining({ name: "lookup", arguments: { id: "1" } }),
      );
    } finally {
      await harness.close();
    }
  });
});
