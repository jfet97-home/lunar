import { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  classifyReadOnlyCall,
  classifyToolCall,
  matchesPattern,
  readOnlyEligibility,
} from "./policy.js";

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

  it("allows only trusted reads in read-only mode and lets annotations only narrow it", () => {
    const trust = {
      trustedReadTools: [
        "jira__get_issue",
        "jira__get_or_create",
        "jira__*",
        "*",
      ],
      trustedAnnotationServers: ["wiki", "kb*"],
    };
    const decide = (
      name: string,
      annotations?: Tool["annotations"],
      origin: "internal" | "upstream" = "upstream",
      policy = trust,
    ): ReturnType<typeof classifyReadOnlyCall> =>
      classifyReadOnlyCall({
        name,
        serverName: name.split("__")[0] ?? "",
        origin,
        definition: tool(annotations),
        trust: policy,
      });
    expect(
      decide(
        "mcpx__management_list_servers",
        { readOnlyHint: true },
        "internal",
        noTrust,
      ),
    ).toEqual({ kind: "trusted-read", reason: "built-in-read-only" });
    expect(
      decide(
        "mcpx__management_remove_server",
        { readOnlyHint: false, destructiveHint: true },
        "internal",
      ),
    ).toEqual({ kind: "blocked", reason: "declares-write" });
    expect(decide("jira__get_issue")).toEqual({
      kind: "trusted-read",
      reason: "trusted-tool",
    });
    // patterns can match tools added later, so only exact names count here
    expect(decide("jira__get_comments")).toEqual({
      kind: "blocked",
      reason: "not-trusted",
    });
    expect(decide("jira__new_tool", { readOnlyHint: true })).toEqual({
      kind: "blocked",
      reason: "not-trusted",
    });
    expect(decide("kb-eu__read", { readOnlyHint: true })).toEqual({
      kind: "blocked",
      reason: "not-trusted",
    });
    // the same patterns keep their meaning for per-call approval
    expect(
      classifyToolCall({
        name: "jira__get_comments",
        serverName: "jira",
        origin: "upstream",
        definition: tool(),
        trust,
      }),
    ).toEqual({ kind: "trusted-read", reason: "trusted-tool" });
    // an exact entry does not override a declared write
    expect(decide("jira__get_or_create", { readOnlyHint: false })).toEqual({
      kind: "blocked",
      reason: "declares-write",
    });
    expect(
      decide("jira__get_issue", { readOnlyHint: true, destructiveHint: true }),
    ).toEqual({ kind: "blocked", reason: "declares-write" });
    expect(decide("wiki__read", { readOnlyHint: true })).toEqual({
      kind: "trusted-read",
      reason: "trusted-annotations",
    });
    expect(decide("wiki__write")).toEqual({
      kind: "blocked",
      reason: "not-trusted",
    });
    // an upstream hint on an untrusted server is only a hint
    expect(
      decide("sentry__read", { readOnlyHint: true }, "upstream", noTrust),
    ).toEqual({ kind: "blocked", reason: "not-trusted" });
    expect(decide("sentry__read", undefined, "upstream", noTrust)).toEqual({
      kind: "blocked",
      reason: "not-trusted",
    });
  });

  it("reports discovery eligibility as the read-only decision plus reserved names", () => {
    const trust = {
      trustedReadTools: ["docs__get_page", "docs__delete_page", "docs__*"],
      trustedAnnotationServers: ["kb"],
    };
    const cases: [string, Tool["annotations"], "internal" | "upstream"][] = [
      ["mcpx__management_list_servers", { readOnlyHint: true }, "internal"],
      ["docs__get_page", undefined, "upstream"],
      ["docs__delete_page", { destructiveHint: true }, "upstream"],
      ["docs__purge", undefined, "upstream"],
      ["kb__read", { readOnlyHint: true }, "upstream"],
      ["kb__write", { readOnlyHint: false }, "upstream"],
      ["wiki__read", { readOnlyHint: true }, "upstream"],
    ];
    const reported = cases.map(([name, annotations, origin]) => {
      const props = {
        name,
        serverName: name.split("__")[0] ?? "",
        origin,
        definition: tool(annotations),
        trust,
      };
      // the same decision mcpx_execute_readonly makes before dispatch
      const decision = classifyReadOnlyCall(props);
      const eligibility = readOnlyEligibility(props);
      expect(eligibility.eligible).toBe(decision.kind === "trusted-read");
      return [name, eligibility];
    });
    expect(Object.fromEntries(reported)).toEqual({
      mcpx__management_list_servers: { eligible: true },
      docs__get_page: { eligible: true },
      docs__delete_page: { eligible: false, reason: "declares_write" },
      docs__purge: { eligible: false, reason: "not_trusted" },
      kb__read: { eligible: true },
      kb__write: { eligible: false, reason: "declares_write" },
      wiki__read: { eligible: false, reason: "not_trusted" },
    });
    for (const name of ["mcpx_execute_readonly", "mcpx_call_tool"]) {
      expect(
        readOnlyEligibility({
          name,
          serverName: "mcpx",
          origin: "internal",
          definition: tool({ readOnlyHint: true }),
          trust: { trustedReadTools: [name], trustedAnnotationServers: [] },
        }),
      ).toEqual({ eligible: false, reason: "reserved" });
    }
  });

  it("matches anchored patterns with literal punctuation", () => {
    expect(matchesPattern("docs__get_page", "docs__get_page")).toBe(true);
    expect(matchesPattern("docs__get", "docs__get_page")).toBe(false);
    expect(matchesPattern("a.b", "axb")).toBe(false);
    expect(matchesPattern("*__search", "jira__search")).toBe(true);
    expect(matchesPattern("*", "anything")).toBe(true);
  });
});
