import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { classifyToolCall, matchesPattern } from "./policy.js";

function tool(annotations?: Tool["annotations"]): Tool {
  return {
    name: "tool",
    inputSchema: { type: "object" },
    ...(annotations ? { annotations } : {}),
  };
}

const noTrust = { trustedReadTools: [], trustedAnnotationServers: [] };

describe("Code Mode side-effect policy", () => {
  it("trusts only gateway-authored read-only built-ins by default", () => {
    expect(
      classifyToolCall({
        name: "mcpx__management_list_servers",
        serverName: "mcpx",
        origin: "internal",
        definition: tool({ readOnlyHint: true }),
        trust: noTrust,
      }),
    ).toEqual({ kind: "trusted-read", reason: "built-in-read-only" });
    expect(
      classifyToolCall({
        name: "mcpx__management_remove_server",
        serverName: "mcpx",
        origin: "internal",
        definition: tool({ readOnlyHint: false, destructiveHint: true }),
        trust: noTrust,
      }),
    ).toEqual({ kind: "approval-required" });
  });

  it("does not trust an upstream readOnlyHint on its own", () => {
    expect(
      classifyToolCall({
        name: "jira__get_issue",
        serverName: "jira",
        origin: "upstream",
        definition: tool({ readOnlyHint: true }),
        trust: noTrust,
      }),
    ).toEqual({ kind: "approval-required" });
  });

  it("trusts tools that an operator pattern lists, whatever they claim", () => {
    const trust = { ...noTrust, trustedReadTools: ["jira__get_*"] };
    expect(
      classifyToolCall({
        name: "jira__get_issue",
        serverName: "jira",
        origin: "upstream",
        definition: tool(),
        trust,
      }),
    ).toEqual({ kind: "trusted-read", reason: "trusted-tool" });
    expect(
      classifyToolCall({
        name: "jira__create_issue",
        serverName: "jira",
        origin: "upstream",
        definition: tool({ readOnlyHint: true }),
        trust,
      }),
    ).toEqual({ kind: "approval-required" });
  });

  it("trusts read-only annotations only for operator-trusted servers", () => {
    const trust = { ...noTrust, trustedAnnotationServers: ["honeycomb*"] };
    const classify = (
      serverName: string,
      annotations?: Tool["annotations"],
    ): ReturnType<typeof classifyToolCall> =>
      classifyToolCall({
        name: `${serverName}__query`,
        serverName,
        origin: "upstream",
        definition: tool(annotations),
        trust,
      });
    expect(classify("honeycomb-eu", { readOnlyHint: true })).toEqual({
      kind: "trusted-read",
      reason: "trusted-annotations",
    });
    expect(
      classify("honeycomb-eu", { readOnlyHint: true, destructiveHint: true }),
    ).toEqual({ kind: "approval-required" });
    expect(classify("honeycomb-eu")).toEqual({ kind: "approval-required" });
    expect(classify("sentry", { readOnlyHint: true })).toEqual({
      kind: "approval-required",
    });
  });

  it("matches anchored patterns with literal punctuation", () => {
    expect(matchesPattern("docs__get_page", "docs__get_page")).toBe(true);
    expect(matchesPattern("docs__get", "docs__get_page")).toBe(false);
    expect(matchesPattern("a.b", "axb")).toBe(false);
    expect(matchesPattern("*__search", "jira__search")).toBe(true);
    expect(matchesPattern("*", "anything")).toBe(true);
  });
});
