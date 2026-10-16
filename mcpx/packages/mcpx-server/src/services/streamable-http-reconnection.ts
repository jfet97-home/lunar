import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
  type StreamableHTTPReconnectionOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export class UpstreamSessionExpiredError extends Error {
  constructor(readonly requestMethod: "GET" | "POST" = "POST") {
    super(
      "Upstream MCP session expired (HTTP 404); the request was not replayed.",
    );
    this.name = "UpstreamSessionExpiredError";
  }
}

// allow supported notification streams to survive a short outage without an unbounded retry loop
export const upstreamStreamReconnectionOptions: StreamableHTTPReconnectionOptions =
  {
    initialReconnectionDelay: 1_000,
    maxReconnectionDelay: 30_000,
    reconnectionDelayGrowFactor: 1.5,
    maxRetries: 15,
  };

export function createUpstreamHttpTransport(
  url: URL,
  options: StreamableHTTPClientTransportOptions,
): StreamableHTTPClientTransport {
  const upstreamFetch = options.fetch ?? fetch;
  return new StreamableHTTPClientTransport(url, {
    ...options,
    fetch: async (input, init): Promise<Response> => {
      const response = await upstreamFetch(input, init);
      const method = init?.method?.toUpperCase() ?? "GET";
      if (
        response.status === 404 &&
        (method === "POST" || method === "GET") &&
        new Headers(init?.headers).has("mcp-session-id")
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new UpstreamSessionExpiredError(method);
      }
      return response;
    },
    reconnectionOptions: upstreamStreamReconnectionOptions,
  });
}
