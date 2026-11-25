import { CallToolRequest, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ReadOnlyEligibility } from "../code-mode/policy.js";
import {
  isLazyManagementCapability,
  LAZY_TOOLS,
  resolveLazyToolRequest,
} from "./lazy-tools.js";

function request(name: string, args: Record<string, unknown>): CallToolRequest {
  return { method: "tools/call", params: { name, arguments: args } };
}

function tool(name: string, description = "Read a Confluence page"): Tool {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
  };
}

describe("lazy tool discovery", () => {
  it("advertises four tools and does not mark execution read-only", () => {
    expect(LAZY_TOOLS.map((tool) => tool.name)).toEqual([
      "mcpx_list_servers",
      "mcpx_search_tools",
      "mcpx_get_tool_schema",
      "mcpx_call_tool",
    ]);
    expect(
      LAZY_TOOLS.find((tool) => tool.name === "mcpx_call_tool")?.annotations
        ?.readOnlyHint,
    ).toBe(false);
  });

  it("recognizes only registered management capabilities from the internal MCPX provider", () => {
    const capability = {
      serverName: "mcpx",
      capabilityName: "management_list_servers",
      definition: { name: "mcpx__management_list_servers" },
    };
    expect(
      isLazyManagementCapability({ ...capability, origin: "internal" }),
    ).toBe(true);
    expect(
      isLazyManagementCapability({ ...capability, origin: "upstream" }),
    ).toBe(false);
    expect(
      isLazyManagementCapability({
        ...capability,
        serverName: "dynamic",
        origin: "internal",
      }),
    ).toBe(false);
    expect(
      isLazyManagementCapability({
        ...capability,
        capabilityName: "management_forged_tool",
        definition: { name: "mcpx__management_forged_tool" },
        origin: "internal",
      }),
    ).toBe(false);
  });

  it.each(["reconnect", "refresh"])(
    "allows the internal credential-preserving %s action directly",
    (action) => {
      expect(
        isLazyManagementCapability({
          serverName: "mcpx",
          capabilityName: `management_${action}_server`,
          origin: "internal",
          definition: { name: `mcpx__management_${action}_server` },
        }),
      ).toBe(true);
    },
  );

  it("lists server names with bounded existing descriptions and no extra metadata", async () => {
    const result = await resolveLazyToolRequest(
      request("mcpx_list_servers", {}),
      [],
      undefined,
      () => [
        { name: "docs", description: "d".repeat(10000), privateNote: "secret" },
        { name: "custom" },
      ],
    );
    expect(result).toEqual({
      kind: "result",
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              servers: [
                { name: "docs", description: "d".repeat(300) },
                { name: "custom" },
              ],
            }),
          },
        ],
      },
    });
  });

  it("rejects unexpected server-list arguments before retrieving metadata", async () => {
    const listServers = jest.fn(() => []);
    const result = await resolveLazyToolRequest(
      request("mcpx_list_servers", { includeSecrets: true }),
      [],
      undefined,
      listServers,
    );
    expect(result).toMatchObject({ kind: "result", result: { isError: true } });
    expect(listServers).not.toHaveBeenCalled();
  });

  it("bounds discovery output, truncates descriptions, and omits schemas", async () => {
    const catalog = Array.from({ length: 233 }, (_, index) =>
      tool(`confluence__page_${index}`, "x".repeat(10000)),
    );
    const firstTool = catalog[0];
    if (!firstTool) throw new Error("expected a tool in the catalog");
    firstTool.title = "t".repeat(10000);
    firstTool.annotations = {
      title: "a".repeat(10000),
      readOnlyHint: true,
      internalNote: "private".repeat(10000),
    } as NonNullable<Tool["annotations"]>;
    const result = await resolveLazyToolRequest(
      request("mcpx_search_tools", { query: "confluence", limit: 3 }),
      catalog,
    );
    expect(result.kind).toBe("result");
    if (result.kind !== "result") throw new Error("unexpected execution");
    const text = result.result.content[0];
    if (text?.type !== "text") throw new Error("expected discovery text");
    const output = JSON.parse(text.text);
    expect(output.tools).toHaveLength(3);
    expect(
      output.tools.every(
        (entry: { description: string }) => entry.description.length === 300,
      ),
    ).toBe(true);
    expect(text.text).not.toMatch(/inputSchema|outputSchema/);
    expect(output.nextOffset).toBe(3);
    expect(output.totalMatches).toBe(233);
    expect(output.tools[0]).toMatchObject({
      title: "t".repeat(300),
      annotations: { title: "a".repeat(300), readOnlyHint: true },
    });
    expect(text.text).not.toContain("internalNote");
    expect(text.text).not.toContain("private");
  });

  it("can find a tool beyond the first upstream catalog page", async () => {
    const catalog = Array.from({ length: 233 }, (_, index) =>
      tool(`svc__tool_${index}`),
    );
    const result = await resolveLazyToolRequest(
      request("mcpx_search_tools", { query: "svc__tool_200" }),
      catalog,
    );
    expect(result).toMatchObject({
      kind: "result",
      result: {
        content: [
          { type: "text", text: expect.stringContaining("svc__tool_200") },
        ],
      },
    });
    const schema = await resolveLazyToolRequest(
      request("mcpx_get_tool_schema", { name: "svc__tool_200" }),
      catalog,
    );
    expect(schema).toMatchObject({
      kind: "result",
      result: { content: [{ text: JSON.stringify(catalog[200]) }] },
    });
  });

  it("filters read-only eligibility over the unfiltered ranking with accurate paging", async () => {
    const catalog = ["svc__write", "svc__read", "svc__drop", "svc__list"].map(
      (name) => tool(name),
    );
    const write = catalog[0];
    if (!write) throw new Error("expected a tool in the catalog");
    write.annotations = { readOnlyHint: true, destructiveHint: true };
    const decisions: Record<string, ReadOnlyEligibility> = {
      svc__write: { eligible: false, reason: "declares_write" },
      svc__read: { eligible: true },
      svc__drop: { eligible: false, reason: "not_trusted" },
      svc__list: { eligible: true },
    };
    // a fixed ranking in which an ineligible tool comes first
    const search = jest.fn(async (tools: Tool[]) => tools);
    const page = async (args: Record<string, unknown>) => {
      const result = await resolveLazyToolRequest(
        request("mcpx_search_tools", { query: "svc", ...args }),
        catalog,
        search,
        undefined,
        undefined,
        (candidate) => decisions[candidate.name] ?? { eligible: true },
      );
      if (result.kind !== "result") throw new Error("unexpected execution");
      const text = result.result.content[0];
      if (text?.type !== "text") throw new Error("expected discovery text");
      return JSON.parse(text.text);
    };

    const unfiltered = await page({ limit: 20 });
    expect(unfiltered).toEqual({
      tools: catalog.map((entry) => ({
        name: entry.name,
        description: entry.description,
        ...(entry.annotations ? { annotations: entry.annotations } : {}),
        readOnlyEligibility: decisions[entry.name],
      })),
      totalMatches: 4,
    });
    // upstream hints stay as they are, beside the gateway's own decision
    expect(unfiltered.tools[0]).toMatchObject({
      annotations: { readOnlyHint: true, destructiveHint: true },
      readOnlyEligibility: { eligible: false, reason: "declares_write" },
    });
    expect(await page({ limit: 20, readOnly: false })).toEqual(unfiltered);

    expect(await page({ limit: 1, readOnly: true })).toEqual({
      tools: [expect.objectContaining({ name: "svc__read" })],
      totalMatches: 2,
      nextOffset: 1,
    });
    expect(await page({ limit: 1, offset: 1, readOnly: true })).toEqual({
      tools: [
        expect.objectContaining({
          name: "svc__list",
          readOnlyEligibility: { eligible: true },
        }),
      ],
      totalMatches: 2,
    });
    // the same query reaches the same index whatever the filter
    expect(search.mock.calls.every(([tools]) => tools === catalog)).toBe(true);

    const invalid = await resolveLazyToolRequest(
      request("mcpx_search_tools", { query: "svc", readOnly: "yes" }),
      catalog,
    );
    expect(invalid).toMatchObject({
      kind: "result",
      result: { isError: true },
    });
  });

  it("reports read-only execution as unavailable when the gateway cannot run it", async () => {
    const catalog = [tool("svc__read")];
    const unfiltered = await resolveLazyToolRequest(
      request("mcpx_search_tools", { query: "svc__read" }),
      catalog,
    );
    expect(unfiltered).toMatchObject({
      kind: "result",
      result: {
        content: [
          {
            text: expect.stringContaining(
              '"readOnlyEligibility":{"eligible":false,"reason":"unavailable"}',
            ),
          },
        ],
      },
    });
    const filtered = await resolveLazyToolRequest(
      request("mcpx_search_tools", { query: "svc__read", readOnly: true }),
      catalog,
    );
    expect(filtered).toMatchObject({
      kind: "result",
      result: {
        isError: true,
        content: [
          {
            text: expect.stringContaining(
              "mcpx_execute_readonly is not available",
            ),
          },
        ],
      },
    });
  });

  it.each(["mcpx_get_tool_schema", "mcpx_call_tool"])(
    "does not reveal or execute unavailable tools through %s",
    async (name) => {
      const result = await resolveLazyToolRequest(
        request(name, { name: "denied__secret" }),
        [tool("allowed__read")],
      );
      expect(result).toMatchObject({
        kind: "result",
        result: { isError: true },
      });
      expect(JSON.stringify(result)).not.toContain("denied__secret");
    },
  );

  it("rejects unbounded discovery and invalid execution arguments", async () => {
    for (const args of [
      { query: "page", limit: 999 },
      { query: "" },
      { query: "page", offset: -1 },
    ]) {
      expect(
        await resolveLazyToolRequest(request("mcpx_search_tools", args), []),
      ).toMatchObject({ kind: "result", result: { isError: true } });
    }
    expect(
      await resolveLazyToolRequest(
        request("mcpx_call_tool", { name: "svc__read", arguments: [] }),
        [tool("svc__read")],
      ),
    ).toMatchObject({ kind: "result", result: { isError: true } });
  });

  it("unwraps only visible calls and preserves progress and request metadata", async () => {
    const original = request("mcpx_call_tool", {
      name: "svc__read",
      arguments: { id: "42" },
    });
    original.params._meta = { progressToken: "progress", custom: "value" };
    expect(await resolveLazyToolRequest(original, [tool("svc__read")])).toEqual(
      {
        kind: "call",
        request: {
          method: "tools/call",
          params: {
            name: "svc__read",
            arguments: { id: "42" },
            _meta: original.params._meta,
          },
        },
      },
    );
    expect(
      await resolveLazyToolRequest(request("svc__read", {}), [
        tool("svc__read"),
      ]),
    ).toMatchObject({ kind: "result", result: { isError: true } });
  });

  it("passes only explicitly permitted direct management names through", async () => {
    const direct = request("mcpx__management_list_servers", {});
    expect(
      await resolveLazyToolRequest(
        direct,
        [],
        undefined,
        undefined,
        new Set([direct.params.name]),
      ),
    ).toEqual({ kind: "call", request: direct });
    expect(await resolveLazyToolRequest(direct, [])).toMatchObject({
      kind: "result",
      result: { isError: true },
    });
  });
});
