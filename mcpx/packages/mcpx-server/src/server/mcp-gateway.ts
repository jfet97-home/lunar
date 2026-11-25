import { createHash } from "node:crypto";
import { makeError, stableStringify } from "@aigw/core/data";
import { loggableError } from "@aigw/core/logging";
import { measureNonFailable } from "@aigw/core/time";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequest,
  CallToolRequestSchema,
  ElicitResultSchema,
  EmptyResultSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  Prompt,
  ReadResourceRequestSchema,
  Resource,
  ServerCapabilities,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Logger } from "winston";
import { env } from "../env.js";
import { AuditLogEvent } from "../model/audit-log-type.js";
import { Services } from "../services/services.js";
import { TokenExpiredError } from "../errors.js";
import {
  McpxSession,
  ToolCallCacheEntry,
  ToolCallResultUnion,
} from "../model/sessions.js";
import { enabledCapabilityKinds } from "../services/capability-registry.js";
import {
  ActiveCapability,
  ActiveTool,
  ConsumerContext,
  UnavailableReason,
} from "../services/capability-resolver.js";
import {
  HiddenInternalCapabilityError,
  UnknownInternalCapabilityError,
} from "../services/internal-capabilities-service.js";
import { BehaviorSetting } from "../services/behavior-service.js";
import { isPingUnsupportedError } from "../services/session-liveness.js";
import {
  LAZY_INSTRUCTIONS,
  LAZY_TOOLS,
  LazyServer,
  isLazyManagementCapability,
  resolveLazyToolRequest,
} from "./lazy-tools.js";
import { LocalToolSearch } from "../services/local-tool-search.js";
import { normalizeServerName } from "@mcpx/toolkit-core/data";
import { isConnected } from "../services/target-client-types.js";
import {
  createElicitationApprover,
  supportsFormElicitation,
} from "../code-mode/approval.js";
import {
  CodeModeGateway,
  GatewayRejectionCode,
  ResolvedCall,
} from "../code-mode/execute.js";
import {
  ReadOnlyEligibility,
  readOnlyEligibility,
} from "../code-mode/policy.js";
import {
  CATALOG_INSTRUCTIONS,
  CODE_MODE_INSTRUCTIONS,
  CODE_MODE_READONLY_TOOL_NAME,
  CODE_MODE_TOOL_NAME,
} from "../code-mode/tool.js";
const toolSearches = new WeakMap<Services, LocalToolSearch>();
const MIN_PROTOCOL_VERSION_FOR_KEEPALIVE = "2025-11-25";
const MAX_KEEPALIVE_TIMEOUT_RATIO = 0.8;
type RequestHandler = Parameters<Server["setRequestHandler"]>[1];
type Extra = Parameters<RequestHandler>[1];
type SendRequest = Extra["sendRequest"];
type SendNotification = Extra["sendNotification"];

// A function to get the server instance for a given session.
// If `shouldReturnEmptyServer` is true, it returns an empty server instance.
// This is done in order to handle a hack in `mcp-remote`,
// which is currently the recommended way to connect to the MCPX server
// from clients that support STDIO transport only.
export async function getServer(
  services: Services,
  logger: Logger,
  shouldReturnEmptyServer: boolean,
  toolMode: "catalog" | "lazy" = "catalog",
): Promise<Server> {
  const enabledKinds = enabledCapabilityKinds({
    enableSkillScoping: env.ENABLE_SKILL_SCOPING,
    enablePromptCapability: env.ENABLE_PROMPT_CAPABILITY,
    enableResourceCapability: services.behaviorService.get(
      BehaviorSetting.ENABLE_RESOURCE_CAPABILITY,
    ),
  });
  const capabilities: ServerCapabilities = {};
  for (const kind of enabledKinds) {
    capabilities[kind] = { listChanged: true };
  }
  const codeMode = services.codeMode;
  const instructions =
    toolMode === "lazy"
      ? codeMode.available
        ? `${LAZY_INSTRUCTIONS} ${CODE_MODE_INSTRUCTIONS}`
        : LAZY_INSTRUCTIONS
      : codeMode.available
        ? CATALOG_INSTRUCTIONS
        : undefined;
  const server = new Server(
    { name: "mcpx", version: "1.0.0" },
    {
      capabilities,
      ...(instructions ? { instructions } : {}),
    },
  );
  if (shouldReturnEmptyServer) {
    return server;
  }

  server.setRequestHandler(
    ListToolsRequestSchema,
    async (_request, { sessionId }) => {
      logger.info("ListToolsRequest received", { sessionId });
      const consumer = services.sessions.getConsumerContext(sessionId);

      const permittedTools =
        services.capabilityResolver.getPermittedTools(consumer);
      const codeModeTools = codeMode.available ? codeMode.tools : [];
      if (toolMode === "lazy") {
        const managementTools = listLazyManagementTools(
          permittedTools,
          consumer,
          services,
        );
        return {
          tools: [...LAZY_TOOLS, ...codeModeTools, ...managementTools],
        };
      }

      const tools: Tool[] = [
        ...listVisibleDefinitions(permittedTools, consumer, (cap, consumer) =>
          services.internalCapabilities.visibleToolForListing(cap, consumer),
        ),
        ...codeModeTools,
      ];

      if (logger.isSillyEnabled()) {
        logger.debug("ListToolsRequest response", { tools });
      } else {
        logger.debug("ListToolsRequest response", { toolCount: tools.length });
      }
      return { tools };
    },
  );

  if (enabledKinds.includes("prompts")) {
    server.setRequestHandler(
      ListPromptsRequestSchema,
      async (_request, { sessionId }) => {
        logger.info("ListPromptsRequest received", { sessionId });
        const consumer = services.sessions.getConsumerContext(sessionId);
        const prompts: Prompt[] = listVisibleDefinitions(
          services.capabilityResolver.getPermittedPrompts(consumer),
          consumer,
          (cap, consumer) =>
            services.internalCapabilities.visiblePromptForListing(
              cap,
              consumer,
            ),
        );
        logger.debug("ListPromptsRequest response", {
          promptCount: prompts.length,
        });
        return { prompts };
      },
    );

    server.setRequestHandler(
      GetPromptRequestSchema,
      async (request, { sessionId }) => {
        logger.info("GetPromptRequest received", {
          sessionId,
          name: request.params.name,
        });
        const consumer = services.sessions.getConsumerContext(sessionId);
        const resolved = services.capabilityResolver.resolvePromptGet(
          request.params.name,
          consumer,
        );
        if (!resolved.ok) {
          throw makeUnavailableError(
            "Prompt",
            request.params.name,
            resolved.reason,
          );
        }
        const { entry } = resolved;
        const session = sessionId
          ? services.sessions.getSession(sessionId)
          : undefined;
        // Internal prompts (skills as /slash) get their messages locally; upstream
        // prompts forward to the owning server, like CallTool.
        const result =
          entry.origin === "internal"
            ? services.internalCapabilities.dispatchPrompt(entry, consumer)
            : await services.upstreamHandler.getPrompt(entry.serverName, {
                ...request.params,
                name: entry.capabilityName,
                _meta: withCallerAuthorization(
                  request.params._meta,
                  session?.metadata.authorization,
                ),
              });
        if (!result) {
          throw makeUnavailableError("Prompt", request.params.name, "unknown");
        }
        services.systemStateTracker.recordPromptGet({
          targetServerName: entry.serverName,
          promptName: entry.capabilityName,
          sessionId,
        });
        const promptUsedEvent: AuditLogEvent = {
          eventType: "prompt_used",
          payload: {
            promptName: entry.capabilityName,
            targetServerName: entry.serverName,
            args: request.params.arguments || undefined,
            consumerTag: consumer.consumerTag || undefined,
          },
        };
        services.auditLog.log(promptUsedEvent);
        return result;
      },
    );
  }

  if (enabledKinds.includes("resources")) {
    server.setRequestHandler(
      ListResourcesRequestSchema,
      async (_request, { sessionId }) => {
        logger.info("ListResourcesRequest received", { sessionId });
        const consumer = services.sessions.getConsumerContext(sessionId);
        const resources: Resource[] = listVisibleDefinitions(
          services.capabilityResolver.getPermittedResources(consumer),
          consumer,
          (cap, consumer) =>
            services.internalCapabilities.visibleResourceForListing(
              cap,
              consumer,
            ),
        );
        logger.debug("ListResourcesRequest response", {
          resourceCount: resources.length,
        });
        return { resources };
      },
    );

    server.setRequestHandler(
      ReadResourceRequestSchema,
      async (request, { sessionId }) => {
        logger.info("ReadResourceRequest received", {
          sessionId,
          uri: request.params.uri,
        });
        const consumer = services.sessions.getConsumerContext(sessionId);
        const resolved = services.capabilityResolver.resolveResourceRead(
          request.params.uri,
          consumer,
        );
        if (!resolved.ok) {
          throw makeUnavailableError(
            "Resource",
            request.params.uri,
            resolved.reason,
          );
        }
        const { entry } = resolved;
        // Only internal-origin resources exist today; an upstream resource
        // would forward to entry.serverName, like GetPrompt.
        const result =
          entry.origin === "internal"
            ? services.internalCapabilities.dispatchResource(entry, consumer)
            : undefined;
        if (!result) {
          throw makeUnavailableError("Resource", request.params.uri, "unknown");
        }
        const resourceReadEvent: AuditLogEvent = {
          eventType: "resource_read",
          payload: {
            resourceUri: entry.capabilityName,
            targetServerName: entry.serverName,
            consumerTag: consumer.consumerTag || undefined,
          },
        };
        services.auditLog.log(resourceReadEvent);
        return result;
      },
    );
  }

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, { sessionId, sendNotification, sendRequest, signal }) => {
      const codeModeName = request.params.name;
      if (
        codeMode.available &&
        (codeModeName === CODE_MODE_TOOL_NAME ||
          codeModeName === CODE_MODE_READONLY_TOOL_NAME)
      ) {
        const keepaliveStopper = setupDownstreamKeepalive({
          request,
          supportsKeepalive: supportsDownstreamKeepalive(services, sessionId),
          supportsPing: supportsDownstreamPing(services, sessionId),
          sendNotification,
          sendRequest,
          signal,
          logger,
        });
        try {
          return await codeMode.execute({
            args: request.params.arguments ?? {},
            readOnly: codeModeName === CODE_MODE_READONLY_TOOL_NAME,
            gateway: buildCodeModeGateway({ services, sessionId, logger }),
            approve: createElicitationApprover({
              supported: () =>
                supportsFormElicitation(server.getClientCapabilities()),
              send: ({ params, signal, timeoutMs }) =>
                sendRequest(
                  { method: "elicitation/create", params },
                  ElicitResultSchema,
                  { signal, timeout: timeoutMs },
                ),
              maxArgumentsChars:
                codeMode.config.limits.maxApprovalArgumentsChars,
            }),
            signal,
          });
        } finally {
          keepaliveStopper();
        }
      }
      if (toolMode === "lazy") {
        const discovery = lazyDiscoveryContext({
          services,
          sessionId,
          logger,
        });
        const resolved = await resolveLazyToolRequest(
          request,
          discovery.visibleTools,
          discovery.search,
          discovery.listServers,
          discovery.directManagementToolNames,
          discovery.readOnlyEligibilityOf,
        );
        if (resolved.kind === "result") return resolved.result;
        request = resolved.request;
      }
      const session = sessionId
        ? services.sessions.getSession(sessionId)
        : undefined;
      const keepaliveStopper = setupDownstreamKeepalive({
        request,
        supportsKeepalive: supportsDownstreamKeepalive(services, sessionId),
        supportsPing: supportsDownstreamPing(services, sessionId),
        sendNotification,
        sendRequest,
        signal,
        onPingAnswered: sessionId
          ? (): void => services.sessions.liveness.recordPingAnswered(sessionId)
          : undefined,
        onPingUnsupported: sessionId
          ? (): void =>
              services.sessions.liveness.markPingUnsupported(sessionId)
          : undefined,
        logger,
      });
      const consumerTag = session?.metadata.consumerTag;
      const clientName = session?.metadata.clientInfo.name;

      try {
        const resolved = services.capabilityResolver.resolveToolCall(
          request.params.name,
          { consumerTag, clientName },
        );
        if (!resolved.ok) {
          throw makeUnavailableError(
            "Tool",
            request.params.name,
            resolved.reason,
          );
        }
        if (
          resolved.entry.origin === "internal" &&
          !services.internalCapabilities.visibleToolForListing(resolved.entry, {
            consumerTag,
            clientName,
          })
        ) {
          throw makeUnavailableError("Tool", request.params.name, "unknown");
        }
        const authVersion = services.upstreamHandler.getAuthVersion(
          resolved.entry.serverName,
        );
        const cached = getCachedToolCallEntry({
          services,
          session,
          request,
          authVersion,
        });
        switch (cached?.status) {
          case "resolved":
            return cached.result;
          case "rejected":
            throw cached.error;
          case "pending":
            return await cached.promise;
          case undefined:
            break;
        }

        return await createAndAwaitToolCallEntry({
          services,
          session,
          sessionId,
          request,
          clientName,
          consumerTag,
          authorization: session?.metadata.authorization,
          logger,
          authVersion,
        });
      } finally {
        keepaliveStopper();
      }
    },
  );

  return server;
}

function lazyDiscoveryContext(props: {
  services: Services;
  sessionId: string | undefined;
  logger: Logger;
}): {
  visibleTools: Tool[];
  search: (tools: Tool[], query: string) => Promise<Tool[]>;
  listServers: () => LazyServer[];
  directManagementToolNames: Set<string>;
  readOnlyEligibilityOf: ((tool: Tool) => ReadOnlyEligibility) | undefined;
} {
  const { services, sessionId, logger } = props;
  const { codeMode } = services;
  const consumer = services.sessions.getConsumerContext(sessionId);
  const permittedTools =
    services.capabilityResolver.getPermittedTools(consumer);
  const visibleTools = listVisibleDefinitions(
    permittedTools,
    consumer,
    (cap, context) =>
      services.internalCapabilities.visibleToolForListing(cap, context),
  );
  const directManagementToolNames = new Set(
    listLazyManagementTools(permittedTools, consumer, services).map(
      (tool) => tool.name,
    ),
  );
  const permittedByName = new Map(
    permittedTools.map((cap) => [cap.definition.name, cap]),
  );
  const existingSearch = toolSearches.get(services);
  const search = existingSearch ?? new LocalToolSearch(logger);
  if (!existingSearch) {
    toolSearches.set(services, search);
  }
  return {
    visibleTools,
    search: (tools, query) => search.search(tools, query),
    listServers: (): LazyServer[] => {
      const visibleNames = new Set(visibleTools.map((tool) => tool.name));
      const serverNames = new Set(
        permittedTools
          .filter((cap) => visibleNames.has(cap.definition.name))
          .map((cap) => cap.serverName),
      );
      return listVisibleLazyServers(services, serverNames);
    },
    directManagementToolNames,
    readOnlyEligibilityOf: codeMode.available
      ? (tool): ReadOnlyEligibility => {
          const permitted = permittedByName.get(tool.name);
          // the visible definition is the one mcpx_execute_readonly classifies
          return permitted
            ? readOnlyEligibility({
                name: tool.name,
                serverName: permitted.serverName,
                origin: permitted.origin,
                definition: tool,
                trust: codeMode.config.trust,
              })
            : { eligible: false, reason: "unavailable" };
        }
      : undefined,
  };
}

/*
 * Code Mode's view of the gateway for one outer call. The caller identity is
 * captured when the call starts; every later operation fails closed if the
 * session closed or its consumer, client or authorization changed, so inner
 * calls never fall back to an anonymous consumer. Inner calls then use the same
 * resolver, visibility, dispatch, metrics and audit path as a direct call.
 */
function buildCodeModeGateway(props: {
  services: Services;
  sessionId: string | undefined;
  logger: Logger;
}): CodeModeGateway {
  const { services, sessionId, logger } = props;
  const startSession = sessionId
    ? services.sessions.getSession(sessionId)
    : undefined;
  const identity = {
    consumerTag: startSession?.metadata.consumerTag,
    clientName: startSession?.metadata.clientInfo.name,
    authorization: startSession?.metadata.authorization,
  };
  const consumer: ConsumerContext = {
    consumerTag: identity.consumerTag,
    clientName: identity.clientName,
  };
  const identityProblem = (): Extract<ResolvedCall, { ok: false }> | null => {
    if (!sessionId) return null;
    const session = services.sessions.getSession(sessionId);
    if (!startSession || !session) {
      return {
        ok: false,
        code: "session_closed",
        message: "The calling session is closed; no further calls run",
      };
    }
    if (
      session.metadata.consumerTag !== identity.consumerTag ||
      session.metadata.clientInfo.name !== identity.clientName ||
      session.metadata.authorization !== identity.authorization
    ) {
      return {
        ok: false,
        code: "identity_changed",
        message:
          "The calling session's identity or authorization changed; no further calls run",
      };
    }
    return null;
  };
  const resolveEntry = (
    name: string,
  ):
    | Extract<ResolvedCall, { ok: false }>
    | (Extract<ResolvedCall, { ok: true }> & { entry: ActiveTool }) => {
    const problem = identityProblem();
    if (problem) return problem;
    const resolved = services.capabilityResolver.resolveToolCall(
      name,
      consumer,
    );
    if (!resolved.ok) {
      return {
        ok: false,
        code: rejectionCode(resolved.reason),
        message: makeUnavailableError("Tool", name, resolved.reason).message,
      };
    }
    const { entry } = resolved;
    const definition =
      entry.origin === "internal"
        ? services.internalCapabilities.visibleToolForListing(entry, consumer)
        : entry.definition;
    if (!definition) {
      return {
        ok: false,
        code: "not_available",
        message: makeUnavailableError("Tool", name, "unknown").message,
      };
    }
    const target = services.upstreamHandler.clientsByService.get(
      entry.serverName,
    )?.targetServer;
    const binding = createHash("sha256")
      .update(
        stableStringify({
          name,
          serverName: entry.serverName,
          capabilityName: entry.capabilityName,
          origin: entry.origin,
          definition,
          authVersion: services.upstreamHandler.getAuthVersion(
            entry.serverName,
          ),
          target: target ?? null,
          identity,
        }),
      )
      .digest("hex");
    return {
      ok: true,
      serverName: entry.serverName,
      origin: entry.origin,
      definition,
      binding,
      entry,
    };
  };
  return {
    discover: async (tool, args): ReturnType<CodeModeGateway["discover"]> => {
      const problem = identityProblem();
      if (problem) return problem;
      const discovery = lazyDiscoveryContext({ services, sessionId, logger });
      const resolved = await resolveLazyToolRequest(
        { method: "tools/call", params: { name: tool, arguments: args } },
        discovery.visibleTools,
        discovery.search,
        discovery.listServers,
        discovery.directManagementToolNames,
        discovery.readOnlyEligibilityOf,
      );
      return resolved.kind === "result"
        ? resolved.result
        : {
            content: [{ type: "text", text: "Unsupported discovery request" }],
            isError: true,
          };
    },
    resolve: (name): ResolvedCall => {
      const resolved = resolveEntry(name);
      if (!resolved.ok) return resolved;
      const { entry: _entry, ...call } = resolved;
      return call;
    },
    dispatch: async (
      name,
      args,
      binding,
    ): ReturnType<CodeModeGateway["dispatch"]> => {
      const resolved = resolveEntry(name);
      if (!resolved.ok) {
        return {
          kind: "rejected",
          code: resolved.code,
          message: resolved.message,
        };
      }
      if (resolved.binding !== binding) {
        return {
          kind: "rejected",
          code: "target_changed",
          message:
            "The tool, its server, its authorization or the session changed after the call was classified or approved, so it did not run",
        };
      }
      // the verified entry runs directly, with no further name lookup
      const result = await executeResolvedToolCall({
        services,
        sessionId,
        request: { method: "tools/call", params: { name, arguments: args } },
        entry: resolved.entry,
        clientName: identity.clientName,
        consumerTag: identity.consumerTag,
        authorization: identity.authorization,
      });
      return { kind: "result", result };
    },
  };
}

function rejectionCode(reason: UnavailableReason): GatewayRejectionCode {
  switch (reason) {
    case "permission-denied":
      return "permission_denied";
    case "server-inactive":
      return "server_inactive";
    case "unknown":
      return "not_available";
  }
}

function supportsDownstreamPing(
  services: Services,
  sessionId: string | undefined,
): boolean {
  if (!sessionId) {
    return true;
  }
  return (
    services.sessions.getSession(sessionId)?.liveness?.pingSupport !==
    "unsupported"
  );
}

function supportsDownstreamKeepalive(
  services: Services,
  sessionId: string | undefined,
): boolean {
  if (!sessionId) {
    return false;
  }
  const session = services.sessions.getSession(sessionId);
  const protocolVersion = session?.metadata.clientInfo.protocolVersion;
  return isProtocolVersionAtLeast(
    protocolVersion,
    MIN_PROTOCOL_VERSION_FOR_KEEPALIVE,
  );
}

function getProgressToken(
  request: CallToolRequest,
): string | number | undefined {
  const meta = request.params?._meta ?? undefined;
  const token = meta?.progressToken;
  if (typeof token === "string" || typeof token === "number") {
    return token;
  }
  return undefined;
}

function setupDownstreamKeepalive(options: {
  request: CallToolRequest;
  supportsKeepalive: boolean;
  supportsPing: boolean;
  sendNotification?: SendNotification;
  sendRequest?: SendRequest;
  signal?: AbortSignal;
  onPingAnswered?: () => void;
  onPingUnsupported?: () => void;
  logger?: Logger;
}): () => void {
  const {
    request,
    supportsKeepalive,
    supportsPing,
    sendNotification,
    sendRequest,
    signal,
    onPingAnswered,
    onPingUnsupported,
    logger,
  } = options;

  if (!supportsKeepalive || env.DOWNSTREAM_KEEPALIVE_INTERVAL_MS <= 0) {
    return () => {};
  }

  const progressToken = getProgressToken(request);
  const shouldUseProgress = progressToken !== undefined && !!sendNotification;
  const shouldUsePing = !shouldUseProgress && supportsPing && !!sendRequest;
  if (!shouldUseProgress && !shouldUsePing) {
    return () => {};
  }

  let keepaliveInFlight = false;
  let progressCounter = 0;
  let interval: ReturnType<typeof setInterval> | undefined;

  const stop = (): void => {
    if (!interval) {
      return;
    }
    clearInterval(interval);
    interval = undefined;
  };

  const sendKeepalive = async (): Promise<void> => {
    if (keepaliveInFlight) {
      return;
    }
    keepaliveInFlight = true;
    try {
      if (
        shouldUseProgress &&
        progressToken !== undefined &&
        sendNotification
      ) {
        progressCounter += 1;
        await sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: progressCounter,
          },
        });
        return;
      }
      const timeout = Math.floor(
        env.DOWNSTREAM_KEEPALIVE_INTERVAL_MS * MAX_KEEPALIVE_TIMEOUT_RATIO,
      );
      await sendRequest?.({ method: "ping" }, EmptyResultSchema, {
        timeout,
      })
        .then(() => onPingAnswered?.())
        .catch((error) => {
          if (isPingUnsupportedError(error)) {
            onPingUnsupported?.();
            stop();
          }
        });
    } catch (error) {
      logger?.debug("Downstream keepalive failed", {
        error: loggableError(error),
      });
    } finally {
      keepaliveInFlight = false;
    }
  };

  interval = setInterval(() => {
    void sendKeepalive();
  }, env.DOWNSTREAM_KEEPALIVE_INTERVAL_MS);

  if (signal) {
    signal.addEventListener("abort", stop, { once: true });
  }

  return stop;
}

async function executeToolCall(options: {
  services: Services;
  sessionId: string | undefined;
  request: CallToolRequest;
  clientName: string | undefined;
  consumerTag: string | undefined;
  authorization: string | undefined;
}): Promise<ToolCallResultUnion> {
  const { services, request, consumerTag, clientName } = options;

  const resolved = services.capabilityResolver.resolveToolCall(
    request.params.name,
    { consumerTag, clientName },
  );
  if (!resolved.ok) {
    throw makeUnavailableError("Tool", request.params.name, resolved.reason);
  }
  return executeResolvedToolCall({ ...options, entry: resolved.entry });
}

// Dispatch for an entry the caller has just resolved and authorized.
function executeResolvedToolCall(options: {
  services: Services;
  sessionId: string | undefined;
  request: CallToolRequest;
  entry: ActiveTool;
  clientName: string | undefined;
  consumerTag: string | undefined;
  authorization: string | undefined;
}): Promise<ToolCallResultUnion> {
  const {
    services,
    sessionId,
    request,
    entry,
    consumerTag,
    clientName,
    authorization,
  } = options;

  return services.systemStateTracker.trackActiveCall(() => {
    if (entry.origin === "internal") {
      return services.internalCapabilities
        .dispatchTool(entry, request.params.arguments ?? {}, {
          consumerTag,
          clientName,
        })
        .catch((e: unknown) => {
          if (
            e instanceof HiddenInternalCapabilityError ||
            e instanceof UnknownInternalCapabilityError
          ) {
            throw makeUnavailableError("Tool", request.params.name, "unknown");
          }
          throw e;
        });
    }

    return executeUpstreamToolCall({
      services,
      sessionId,
      request,
      serverName: entry.serverName,
      capabilityName: entry.capabilityName,
      clientName,
      consumerTag,
      authorization,
    });
  });
}

function executeUpstreamToolCall(options: {
  services: Services;
  sessionId: string | undefined;
  request: CallToolRequest;
  serverName: string;
  capabilityName: string;
  clientName: string | undefined;
  consumerTag: string | undefined;
  authorization: string | undefined;
}): Promise<ToolCallResultUnion> {
  const {
    services,
    sessionId,
    request,
    serverName,
    capabilityName,
    clientName,
    consumerTag,
    authorization,
  } = options;

  return measureNonFailable(async () => {
    const result = await services.upstreamHandler
      .callTool(serverName, {
        ...request.params,
        name: capabilityName,
        _meta: withCallerAuthorization(request.params._meta, authorization),
      })
      .catch((e: unknown) => {
        if (e instanceof TokenExpiredError) {
          return {
            content: [{ type: "text" as const, text: e.message }],
            isError: true,
          };
        }
        throw e;
      });

    services.systemStateTracker.recordToolCall({
      targetServerName: serverName,
      toolName: capabilityName,
      sessionId,
    });
    const toolUsedEvent: AuditLogEvent = {
      eventType: "tool_used",
      payload: {
        toolName: capabilityName,
        targetServerName: serverName,
        args: request.params.arguments || undefined,
        consumerTag: consumerTag || undefined,
      },
    };
    services.auditLog.log(toolUsedEvent);

    return result;
  }).then((measureToolCallResult) => {
    const sessionMeta = sessionId
      ? services.sessions.getSession(sessionId)?.metadata
      : undefined;

    const isError =
      !measureToolCallResult.success ||
      // Type inference for `.isError` fails, but it is indeed a boolean
      Boolean(measureToolCallResult.result.isError);

    const agentLabel = consumerTag ?? clientName ?? "unidentified_agent";

    const labels: Record<string, string> = {
      tool_name: capabilityName,
      error: isError.toString(),
      agent: agentLabel,
      llm: sessionMeta?.llm?.provider ?? "unknown",
      model: sessionMeta?.llm?.modelId ?? "unknown",
    };

    services.metricRecorder.recordToolCallDuration(
      measureToolCallResult.duration,
      labels,
    );

    services.hubService.recordToolCall({
      serverName,
      toolName: capabilityName,
      clientName,
      consumerTag,
      durationMs: measureToolCallResult.duration,
      isError,
      isCallFailure: !measureToolCallResult.success,
    });

    if (measureToolCallResult.success) {
      return measureToolCallResult.result;
    }
    return Promise.reject(measureToolCallResult.error);
  });
}

// One list-response shape for all kinds: upstream entries arrive already
// permission-filtered by the resolver; internal entries defer to their
// handler's per-consumer visibility (which may also enrich the definition).
function listVisibleDefinitions<T>(
  caps: ActiveCapability<T>[],
  consumer: ConsumerContext,
  visibleForListing: (
    cap: ActiveCapability<T>,
    consumer: ConsumerContext,
  ) => T | undefined,
): T[] {
  return caps.flatMap((cap) => {
    if (cap.origin !== "internal") return [cap.definition];
    const visible = visibleForListing(cap, consumer);
    return visible ? [visible] : [];
  });
}

function listLazyManagementTools(
  permittedTools: ActiveCapability<Tool>[],
  consumer: ConsumerContext,
  services: Services,
): Tool[] {
  return listVisibleDefinitions(
    permittedTools.filter(isLazyManagementCapability),
    consumer,
    (capability, context) =>
      services.internalCapabilities.visibleToolForListing(capability, context),
  );
}

function listVisibleLazyServers(
  services: Services,
  serverNames: Set<string>,
): LazyServer[] {
  const catalog = services.catalogManager.getCatalog();
  return [...serverNames].sort().flatMap((name) => {
    if (name === "mcpx") {
      return [
        {
          name,
          description:
            "MCPX built-in capabilities for managing MCP servers, backups, and authentication.",
        },
      ];
    }
    const client = services.upstreamHandler.clientsByService.get(name);
    if (!client) return [];
    const catalogEntry = catalog.find((entry) =>
      client.targetServer.catalogItemId
        ? entry.id === client.targetServer.catalogItemId
        : normalizeServerName(entry.name) === name,
    );
    const serverInfo = isConnected(client)
      ? client.extendedClient.serverInfo
      : undefined;
    const description =
      client.targetServer.description?.trim() ||
      serverInfo?.description?.trim() ||
      catalogEntry?.description?.trim();
    return [{ name, ...(description ? { description } : {}) }];
  });
}

// Single mapping site for wire-level error strings. IT test asserts on
// `/not available/i`.
function makeUnavailableError(
  kind: "Tool" | "Prompt" | "Resource",
  name: string,
  reason: UnavailableReason,
): Error {
  switch (reason) {
    case "permission-denied":
      return new Error("Permission denied");
    case "server-inactive":
      return new Error(`${kind} ${name} is not available (server inactive)`);
    case "unknown":
      return new Error(`${kind} ${name} is not available`);
    default: {
      // Exhaustiveness check — new UnavailableReason variants force a compile
      // error here.
      const _exhaustive: never = reason;
      throw new Error(`Unhandled reason: ${String(_exhaustive)}`);
    }
  }
}

function isToolCallCacheable(options: {
  services: Services;
  session: McpxSession | undefined;
  request: CallToolRequest;
}): boolean {
  const { services, session, request } = options;
  return (
    !request.params.name.startsWith("mcpx__management_") &&
    services.behaviorService.get(BehaviorSetting.ENABLE_TOOL_CALL_CACHE) &&
    session !== undefined &&
    hasExplicitCorrelationKey(request)
  );
}

function getCachedToolCallEntry(options: {
  services: Services;
  session: McpxSession | undefined;
  request: CallToolRequest;
  authVersion: number;
}): ToolCallCacheEntry | undefined {
  const { session, request } = options;
  if (!session || !isToolCallCacheable(options)) {
    return undefined;
  }

  const cache = getSessionCache(session);
  pruneExpiredCacheEntries(cache);

  const cacheKey = buildToolCallCacheKey(request, options.authVersion);
  return cache.get(cacheKey);
}

async function createAndAwaitToolCallEntry(options: {
  services: Services;
  session: McpxSession | undefined;
  sessionId: string | undefined;
  request: CallToolRequest;
  clientName: string | undefined;
  consumerTag: string | undefined;
  authorization: string | undefined;
  logger: Logger;
  authVersion: number;
}): Promise<ToolCallResultUnion> {
  const {
    services,
    session,
    sessionId,
    request,
    clientName,
    consumerTag,
    authorization,
    logger,
  } = options;
  // Cache disabled, no session, or no correlation key → skip the cache entirely.
  if (
    !sessionId ||
    !session ||
    !isToolCallCacheable({ services, session, request })
  ) {
    return executeToolCall({
      services,
      sessionId,
      request,
      clientName,
      consumerTag,
      authorization,
    });
  }

  const cache = getSessionCache(session);
  pruneExpiredCacheEntries(cache);

  const cacheKey = buildToolCallCacheKey(request, options.authVersion);
  const existing = cache.get(cacheKey);
  if (existing) {
    if (existing.status === "resolved") {
      return existing.result;
    }
    if (existing.status === "rejected") {
      throw existing.error;
    }
    return existing.promise;
  }

  const expiresAt = Date.now() + env.TOOL_CALL_CACHE_TTL_MS;
  const promise = executeToolCall({
    services,
    sessionId,
    request,
    clientName,
    consumerTag,
    authorization,
  })
    .then((result) => {
      cache.set(cacheKey, {
        status: "resolved",
        result,
        expiresAt: Date.now() + env.TOOL_CALL_CACHE_TTL_MS,
      });
      enforceCacheLimit(cache, env.TOOL_CALL_CACHE_MAX_ENTRIES, logger);
      return result;
    })
    .catch((error) => {
      const normalizedError = makeError(error);
      cache.set(cacheKey, {
        status: "rejected",
        error: normalizedError,
        expiresAt: Date.now() + env.TOOL_CALL_CACHE_TTL_MS,
      });
      enforceCacheLimit(cache, env.TOOL_CALL_CACHE_MAX_ENTRIES, logger);
      logger.debug("Tool call failed", { cacheKey, error: normalizedError });
      throw normalizedError;
    });

  cache.set(cacheKey, {
    status: "pending",
    promise,
    expiresAt,
  });
  enforceCacheLimit(cache, env.TOOL_CALL_CACHE_MAX_ENTRIES, logger);

  return promise;
}

function getSessionCache(session: {
  toolCallCache?: Map<string, ToolCallCacheEntry>;
}): Map<string, ToolCallCacheEntry> {
  if (!session.toolCallCache) {
    session.toolCallCache = new Map();
  }
  return session.toolCallCache;
}

export function pruneExpiredCacheEntries(
  cache: Map<string, ToolCallCacheEntry>,
): void {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
}

export function enforceCacheLimit(
  cache: Map<string, ToolCallCacheEntry>,
  maxEntries: number,
  logger?: Logger,
): void {
  if (maxEntries <= 0 || cache.size <= maxEntries) {
    return;
  }

  const evict = (predicate: (entry: ToolCallCacheEntry) => boolean): void => {
    for (const [key, entry] of cache.entries()) {
      if (!predicate(entry)) {
        continue;
      }
      cache.delete(key);
      if (cache.size <= maxEntries) {
        return;
      }
    }
  };

  // Never evict pending entries: a duplicate request sharing the correlation
  // key would otherwise miss the cache and fire a second upstream call,
  // which is exactly what the cache is supposed to prevent. If the cap is
  // saturated by in-flight calls, we let it briefly exceed maxEntries.
  evict((entry) => entry.status !== "pending");

  if (cache.size > maxEntries) {
    logger?.debug("Tool call cache exceeds limit (in-flight entries)", {
      size: cache.size,
      maxEntries,
    });
  }
}

export function buildToolCallCacheKey(
  request: CallToolRequest,
  authVersion = 0,
): string {
  const explicitKey = extractCallCorrelationKey(request);
  return [
    `progressToken:${typeof explicitKey}:${String(explicitKey)}`,
    `toolName:${request.params.name}`,
    `authVersion:${authVersion}`,
    `arguments:${stableStringify(request.params.arguments)}`,
  ].join("|");
}

function extractCallCorrelationKey(
  request: CallToolRequest,
): string | number | undefined {
  return getProgressToken(request);
}

function hasExplicitCorrelationKey(request: CallToolRequest): boolean {
  return extractCallCorrelationKey(request) !== undefined;
}

function isProtocolVersionAtLeast(
  version: string | undefined,
  minimumVersion: string,
): boolean {
  if (!version) {
    return false;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(version)) {
    return false;
  }
  return version >= minimumVersion;
}

type RequestMeta = CallToolRequest["params"]["_meta"];

function withCallerAuthorization(
  meta: RequestMeta,
  authorization: string | undefined,
): RequestMeta {
  return authorization ? { ...meta, authorization } : meta;
}
