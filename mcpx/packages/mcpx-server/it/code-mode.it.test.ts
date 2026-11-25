import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ElicitRequest,
  ElicitRequestSchema,
  ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { Permissions } from "@mcpx/shared-model";
import express from "express";
import { mkdtempSync, rmSync } from "fs";
import { createServer } from "http";
import { AddressInfo } from "net";
import { tmpdir } from "os";
import path from "path";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { resetEnv } from "../src/env.js";
import { ToolGroup } from "../src/model/config/permissions.js";
import { TargetServer } from "../src/model/target-servers.js";
import {
  buildConfig,
  getTestHarness,
  MCPX_BASE_URL,
  TestHarness,
} from "./utils.js";

/*
 * Full-stack Code Mode check: real Services, permissions, upstream handler,
 * audit and downstream transports, the real sandbox runner, and in-process
 * fake upstream MCP servers whose "writes" only touch memory.
 */

interface FakeUpstream {
  name: string;
  url: string;
  writes: string[];
  calls: { tool: string; args: Record<string, unknown> }[];
  stop: () => Promise<void>;
}

async function startFakeUpstream(name: string): Promise<FakeUpstream> {
  const writes: string[] = [];
  const calls: FakeUpstream["calls"] = [];
  const notes = [
    { id: "n1", title: "Alpha", size: 10 },
    { id: "n2", title: "Beta", size: 900 },
    { id: "n3", title: "Gamma", size: 20 },
  ];
  const app = express();
  app.use(express.json());
  app.all("/mcp", async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).end();
      return;
    }
    const mcp = new McpServer({ name, version: "1.0.0" });
    const record = (tool: string, args: Record<string, unknown>): void => {
      calls.push({ tool, args });
    };
    mcp.registerTool(
      "list_notes",
      { inputSchema: {}, annotations: { readOnlyHint: true } },
      async () => {
        record("list_notes", {});
        return {
          content: [{ type: "text", text: JSON.stringify({ notes }) }],
          structuredContent: { notes },
        };
      },
    );
    mcp.registerTool(
      "get_note",
      {
        inputSchema: { id: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ id }) => {
        record("get_note", { id });
        return {
          content: [
            { type: "text", text: JSON.stringify({ id, body: `${id} body` }) },
          ],
        };
      },
    );
    mcp.registerTool(
      "peek",
      { inputSchema: {}, annotations: { readOnlyHint: true } },
      async () => {
        record("peek", {});
        return { content: [{ type: "text", text: "peeked" }] };
      },
    );
    mcp.registerTool("whoami", { inputSchema: {} }, async (_args, extra) => {
      record("whoami", {});
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              authorization: extra._meta?.["authorization"] ?? null,
            }),
          },
        ],
      };
    });
    mcp.registerTool(
      "slow",
      { inputSchema: { ms: z.number() } },
      async ({ ms }) => {
        record("slow", { ms });
        await new Promise((resolve) => setTimeout(resolve, ms));
        return { content: [{ type: "text", text: "slow done" }] };
      },
    );
    mcp.registerTool(
      "create_note",
      { inputSchema: { title: z.string() } },
      async ({ title }) => {
        record("create_note", { title });
        writes.push(title);
        return { content: [{ type: "text", text: JSON.stringify({ title }) }] };
      },
    );
    mcp.registerTool("secret_note", { inputSchema: {} }, async () => {
      record("secret_note", {});
      return { content: [{ type: "text", text: "secret" }] };
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => void transport.close());
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const httpServer = createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const { port } = httpServer.address() as AddressInfo;
  return {
    name,
    url: `http://localhost:${port}/mcp`,
    writes,
    calls,
    stop: async () => {
      if (!httpServer.listening) return;
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function target(upstream: FakeUpstream, name = upstream.name): TargetServer {
  return { type: "streamable-http", name, url: upstream.url };
}

interface Output {
  ok: boolean;
  result?: unknown;
  error?: { code: string };
  calls: Record<string, unknown>[];
}

const toolGroups: ToolGroup[] = [
  { name: "secret", services: { notes: ["secret_note"] } },
  { name: "reader", services: { notes: ["list_notes", "whoami"] } },
];
const permissions: Permissions = {
  default: { _type: "default-block", allow: [] },
  consumers: {
    agents: { _type: "default-allow", block: ["secret"] },
    guests: { _type: "default-block", allow: ["reader"] },
  },
  clientNames: {},
};

describe("Code Mode through the full gateway", () => {
  jest.setTimeout(60_000);
  const auditDirectory = mkdtempSync(
    path.join(tmpdir(), "mcpx-code-mode-audit-"),
  );
  const clients: Client[] = [];
  let harness: TestHarness;
  let notes: FakeUpstream;
  let replacement: FakeUpstream;
  let later: FakeUpstream;

  async function connect(
    endpoint: "/mcp" | "/mcp/lazy",
    options: {
      consumer?: string;
      authorization?: string;
      elicit?: (request: ElicitRequest) => Promise<ElicitResult>;
    } = {},
  ): Promise<Client> {
    const client = new Client(
      { name: "code-mode-it", version: "1.0.0" },
      options.elicit
        ? { capabilities: { elicitation: { form: {} } } }
        : undefined,
    );
    if (options.elicit) {
      const elicit = options.elicit;
      client.setRequestHandler(ElicitRequestSchema, (request) =>
        elicit(request),
      );
    }
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint, MCPX_BASE_URL), {
        requestInit: {
          headers: {
            "x-lunar-consumer-tag": options.consumer ?? "agents",
            Authorization: options.authorization ?? "Bearer agent-token",
          },
        },
      }),
    );
    clients.push(client);
    return client;
  }

  async function execute(
    client: Client,
    code: string,
    signal?: AbortSignal,
  ): Promise<Output> {
    const result = await client.callTool(
      { name: "mcpx_execute", arguments: { code } },
      undefined,
      signal ? { signal } : undefined,
    );
    const block = (result.content as { type: string; text: string }[])[0];
    return JSON.parse(block?.text ?? "{}") as Output;
  }

  beforeAll(async () => {
    process.env["AUDIT_LOG_DIR"] = auditDirectory;
    resetEnv();
    [notes, replacement, later] = await Promise.all([
      startFakeUpstream("notes"),
      startFakeUpstream("notes"),
      startFakeUpstream("later"),
    ]);
    harness = getTestHarness({
      config: buildConfig({ permissions, toolGroups }),
      targetServers: [target(notes)],
      catalogItems: [notes, later].map((upstream) => ({
        id: uuidv7(),
        name: upstream.name,
        displayName: upstream.name,
        config: { type: "streamable-http", url: upstream.url },
      })),
      clientConnectExtraHeaders: { "x-lunar-consumer-tag": "agents" },
      codeMode: {
        requireToolApproval: true,
        runnerPath: path.resolve(process.cwd(), "src/code-mode/runner.ts"),
        limits: { wallMs: 20_000 },
        trust: {
          trustedReadTools: [
            "notes__list_notes",
            "notes__get_note",
            "notes__whoami",
            "notes__slow",
            "later__*",
          ],
          trustedAnnotationServers: [],
        },
      },
    });
    await harness.initialize("StreamableHTTP");
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    await harness.shutdown();
    await Promise.all([notes.stop(), replacement.stop(), later.stop()]);
    delete process.env["AUDIT_LOG_DIR"];
    resetEnv();
    rmSync(auditDirectory, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const upstream of [notes, replacement, later]) {
      upstream.calls.length = 0;
      upstream.writes.length = 0;
    }
  });

  it("announces mcpx_execute on both endpoints and keeps normal discovery and calls", async () => {
    const catalog = await connect("/mcp");
    const lazy = await connect("/mcp/lazy");
    const catalogNames = (await catalog.listTools()).tools.map((t) => t.name);
    expect(catalogNames).toEqual(
      expect.arrayContaining([
        "notes__list_notes",
        "notes__create_note",
        "mcpx_execute",
      ]),
    );
    expect(catalogNames).not.toContain("notes__secret_note");
    expect((await lazy.listTools()).tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "mcpx_search_tools",
        "mcpx_call_tool",
        "mcpx_execute",
      ]),
    );
    expect(catalog.getInstructions()).toContain("mcpx_execute");
    expect(lazy.getInstructions()).toContain("mcpx_execute");
    const direct = await catalog.callTool({
      name: "notes__get_note",
      arguments: { id: "n1" },
    });
    expect(direct.isError).toBeFalsy();
  });

  it("chains and filters trusted reads with the caller's identity and per-call audit", async () => {
    const log = jest.spyOn(harness.services.auditLog, "log");
    const client = await connect("/mcp/lazy", {
      authorization: "Bearer caller-123",
    });
    const output = await execute(
      client,
      `
        const listed = await mcpx.callTool("notes__list_notes", {});
        const small = listed.data.notes.filter((note) => note.size < 100);
        const bodies = await Promise.all(
          small.map(async (note) => (await mcpx.callTool("notes__get_note", { id: note.id })).data.body),
        );
        const me = await mcpx.callTool("notes__whoami", {});
        return { bodies, caller: me.data.authorization };
      `,
    );
    expect(output).toMatchObject({
      ok: true,
      result: { bodies: ["n1 body", "n3 body"], caller: "Bearer caller-123" },
    });
    expect(notes.calls.map((call) => call.tool)).toEqual([
      "list_notes",
      "get_note",
      "get_note",
      "whoami",
    ]);
    const toolUsed = log.mock.calls
      .map(([event]) => event)
      .filter((event) => event.eventType === "tool_used");
    expect(toolUsed).toHaveLength(4);
    expect(toolUsed[1]).toEqual({
      eventType: "tool_used",
      payload: expect.objectContaining({
        targetServerName: "notes",
        toolName: "get_note",
        args: { id: "n1" },
        consumerTag: "agents",
      }),
    });
    log.mockRestore();
  });

  it("requires per-call approval for writes and untrusted reads, and fails closed without it", async () => {
    const asked: ElicitRequest[] = [];
    const answers: ElicitResult[] = [
      { action: "accept", content: { approve: true } },
      { action: "decline" },
    ];
    const approving = await connect("/mcp", {
      elicit: async (request) => {
        asked.push(request);
        return answers.shift() ?? { action: "cancel" };
      },
    });
    const output = await execute(
      approving,
      `
        const codes = [];
        for (const [name, args] of [["notes__create_note", { title: "kept" }], ["notes__create_note", { title: "declined" }], ["notes__peek", {}]]) {
          try { await mcpx.callTool(name, args); codes.push("ran"); } catch (error) { codes.push(error.code); }
        }
        return codes;
      `,
    );
    expect(output.result).toEqual([
      "ran",
      "approval_declined",
      "approval_cancelled",
    ]);
    expect(asked.map((request) => request.params.message)).toEqual([
      expect.stringContaining('"title": "kept"'),
      expect.stringContaining('"title": "declined"'),
      expect.stringContaining("Tool: notes__peek"),
    ]);
    expect(notes.writes).toEqual(["kept"]);

    const noElicitation = await connect("/mcp");
    const unsupported = await execute(
      noElicitation,
      `try { await mcpx.callTool("notes__create_note", { title: "never" }); } catch (error) { return error.code; }`,
    );
    expect(unsupported.result).toBe("approval_unsupported");
    expect(notes.writes).toEqual(["kept"]);
  });

  it("enforces each caller's permissions and visibility on every inner call", async () => {
    const agents = await connect("/mcp/lazy");
    const guests = await connect("/mcp/lazy", { consumer: "guests" });
    const code = `
      const codes = {};
      for (const name of ["notes__list_notes", "notes__get_note", "notes__secret_note"]) {
        try { await mcpx.callTool(name, { id: "n1" }); codes[name] = "ran"; } catch (error) { codes[name] = error.code; }
      }
      const found = await mcpx.searchTools("notes__get_note");
      return { codes, found: found.tools.map((tool) => tool.name) };
    `;
    const forAgents = (await execute(agents, code)).result as {
      codes: Record<string, string>;
      found: string[];
    };
    expect(forAgents.codes).toEqual({
      notes__list_notes: "ran",
      notes__get_note: "ran",
      notes__secret_note: "permission_denied",
    });
    expect(forAgents.found[0]).toBe("notes__get_note");
    expect(forAgents.found).not.toContain("notes__secret_note");
    const forGuests = (await execute(guests, code)).result as {
      codes: Record<string, string>;
      found: string[];
    };
    expect(forGuests.codes).toEqual({
      notes__list_notes: "ran",
      notes__get_note: "permission_denied",
      notes__secret_note: "permission_denied",
    });
    expect(forGuests.found).not.toContain("notes__get_note");
    expect(notes.calls.map((call) => call.tool)).not.toContain("secret_note");
  });

  it("reaches a server registered after the session started", async () => {
    const client = await connect("/mcp/lazy");
    await harness.services.upstreamHandler.addClient(target(later));
    try {
      const output = await execute(
        client,
        `
          const found = await mcpx.searchTools("later__get_note");
          const note = await mcpx.callTool(found.tools[0].name, { id: "fresh" });
          return note.data;
        `,
      );
      expect(output.result).toEqual({ id: "fresh", body: "fresh body" });
      expect(later.calls).toEqual([
        { tool: "get_note", args: { id: "fresh" } },
      ]);
    } finally {
      await harness.services.upstreamHandler.removeClient("later");
    }
  });

  it("stops scheduling when the caller cancels and never replays the in-flight call", async () => {
    const client = await connect("/mcp");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    await expect(
      execute(
        client,
        `
          await mcpx.callTool("notes__slow", { ms: 800 });
          await mcpx.callTool("notes__get_note", { id: "after-cancel" });
        `,
        controller.signal,
      ),
    ).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(notes.calls).toEqual([{ tool: "slow", args: { ms: 800 } }]);
  });

  it("does not run an approved write after its server was replaced during approval", async () => {
    const services = harness.services;
    const client = await connect("/mcp", {
      elicit: async () => {
        await services.upstreamHandler.removeClient("notes");
        await services.upstreamHandler.addClient(target(replacement, "notes"));
        return { action: "accept", content: { approve: true } };
      },
    });
    try {
      const output = await execute(
        client,
        `try { await mcpx.callTool("notes__create_note", { title: "moved" }); } catch (error) { return error.code; }`,
      );
      expect(output.result).toBe("target_changed");
      expect(notes.writes).toEqual([]);
      expect(replacement.writes).toEqual([]);
    } finally {
      await services.upstreamHandler.removeClient("notes");
      await services.upstreamHandler.addClient(target(notes));
    }
  });
});
