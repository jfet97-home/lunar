import {
  CallToolRequest,
  CallToolResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import z from "zod/v4";
import { ReadOnlyEligibility } from "../code-mode/policy.js";

const MAX_RESULTS = 20;
const MAX_DESCRIPTION_LENGTH = 300;
const MANAGEMENT_CAPABILITY_NAMES = new Set([
  "management_list_servers",
  "management_add_server",
  "management_update_server",
  "management_enable_server",
  "management_disable_server",
  "management_reconnect_server",
  "management_refresh_server",
  "management_remove_server",
  "management_create_backup",
  "management_login_server",
  "management_logout_server",
]);
const listServersSchema = z.object({}).strict();
const searchSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(MAX_RESULTS).default(5),
    offset: z.number().int().min(0).default(0),
    readOnly: z.boolean().default(false),
  })
  .strict();
const nameSchema = z.object({ name: z.string().min(1).max(500) }).strict();
const callSchema = nameSchema
  .extend({
    arguments: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const LAZY_TOOLS: Tool[] = [
  {
    name: "mcpx_list_servers",
    description:
      "Call this first when connecting to MCPX. Lists the MCP servers with tools visible to you, including their existing descriptions when available. Use a returned server name with mcpx_search_tools to find tools for your task.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "mcpx_search_tools",
    description:
      "Find tools by keywords or exact name. Returns a small shortlist without schemas. Search for a service and task, then use mcpx_get_tool_schema for the selected name. Use offset to browse more matches. Each result's readOnlyEligibility is the gateway's decision whether mcpx_execute_readonly would run that tool now, with a reason when it would not; annotations are the upstream's own hints.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_RESULTS,
          default: 5,
        },
        offset: { type: "integer", minimum: 0, default: 0 },
        readOnly: {
          type: "boolean",
          default: false,
          description:
            "Return only tools that mcpx_execute_readonly would run now; totalMatches and nextOffset count only those. Every call is still checked when it runs.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "mcpx_get_tool_schema",
    description:
      "Get the complete definition and argument schema of one tool returned by mcpx_search_tools. Inspect it before calling the tool.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", minLength: 1, maxLength: 500 } },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "mcpx_call_tool",
    description:
      "Execute a discovered tool by its exact name with arguments matching mcpx_get_tool_schema. The target may read, write, or delete data; check its description and annotations first. Gateway permissions apply to the target tool.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 500 },
        arguments: { type: "object", additionalProperties: true },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
  },
];

export const LAZY_INSTRUCTIONS =
  "MCPX is a gateway to multiple MCP servers. At the start of a session, call mcpx_list_servers immediately to learn which servers are available. Call permitted management tools directly by their mcpx__management_* names. For a direct upstream call, use mcpx_search_tools with service and task keywords, then load the chosen tool's schema with mcpx_get_tool_schema and invoke it with mcpx_call_tool. Search results are bounded. Use offset for additional matches.";

export interface LazyManagementCapability {
  serverName: string;
  capabilityName: string;
  origin: string;
  definition: { name: string };
}

export function isLazyManagementCapability(
  capability: LazyManagementCapability,
): boolean {
  return (
    capability.serverName === "mcpx" &&
    capability.origin === "internal" &&
    MANAGEMENT_CAPABILITY_NAMES.has(capability.capabilityName) &&
    capability.definition.name === `mcpx__${capability.capabilityName}`
  );
}

export interface LazyServer {
  name: string;
  description?: string;
}

type LazyRequestResolution =
  | { kind: "result"; result: CallToolResult }
  | { kind: "call"; request: CallToolRequest };

/** Resolve discovery locally and unwrap execution into the ordinary gateway path. */
export async function resolveLazyToolRequest(
  request: CallToolRequest,
  visibleTools: Tool[],
  search: (tools: Tool[], query: string) => Promise<Tool[]> = async (
    tools,
    query,
  ) => rankToolsLexically(tools, query),
  listServers: () => LazyServer[] = () => [],
  directManagementToolNames: ReadonlySet<string> = new Set(),
  // absent when this gateway cannot run read-only scripts
  readOnlyEligibilityOf?: (tool: Tool) => ReadOnlyEligibility,
): Promise<LazyRequestResolution> {
  const args = request.params.arguments ?? {};
  if (request.params.name === "mcpx_list_servers") {
    const parsed = listServersSchema.safeParse(args);
    if (!parsed.success) return invalidArguments(parsed.error.message);
    return jsonResult({
      servers: listServers().map(({ name, description }) => ({
        name,
        ...(description
          ? { description: description.slice(0, MAX_DESCRIPTION_LENGTH) }
          : {}),
      })),
    });
  }
  if (request.params.name === "mcpx_search_tools") {
    const parsed = searchSchema.safeParse(args);
    if (!parsed.success) return invalidArguments(parsed.error.message);
    const { query, limit, offset, readOnly } = parsed.data;
    if (readOnly && !readOnlyEligibilityOf) {
      return errorResult(
        "mcpx_execute_readonly is not available on this gateway, so no tool is eligible for it. Search without readOnly.",
      );
    }
    const eligibility = (tool: Tool): ReadOnlyEligibility =>
      readOnlyEligibilityOf
        ? readOnlyEligibilityOf(tool)
        : { eligible: false, reason: "unavailable" };
    // filter the unfiltered ranking, so eligible tools keep their relative order
    const ranked = await search(visibleTools, query);
    const matches = readOnly
      ? ranked.filter((tool) => eligibility(tool).eligible)
      : ranked;
    const tools = matches.slice(offset, offset + limit).map((tool) => {
      const annotations = projectAnnotations(tool.annotations);
      return {
        name: tool.name,
        ...(tool.title
          ? { title: tool.title.slice(0, MAX_DESCRIPTION_LENGTH) }
          : {}),
        description: (tool.description ?? "").slice(0, MAX_DESCRIPTION_LENGTH),
        ...(annotations ? { annotations } : {}),
        readOnlyEligibility: eligibility(tool),
      };
    });
    return jsonResult({
      tools,
      totalMatches: matches.length,
      ...(offset + limit < matches.length
        ? { nextOffset: offset + limit }
        : {}),
    });
  }

  if (request.params.name === "mcpx_get_tool_schema") {
    const parsed = nameSchema.safeParse(args);
    if (!parsed.success) return invalidArguments(parsed.error.message);
    const tool = visibleTools.find((tool) => tool.name === parsed.data.name);
    return tool ? jsonResult(tool) : unavailableTool();
  }

  if (request.params.name === "mcpx_call_tool") {
    const parsed = callSchema.safeParse(args);
    if (!parsed.success) return invalidArguments(parsed.error.message);
    if (!visibleTools.some((tool) => tool.name === parsed.data.name)) {
      return unavailableTool();
    }
    return {
      kind: "call",
      request: {
        ...request,
        params: {
          ...request.params,
          name: parsed.data.name,
          arguments: parsed.data.arguments,
        },
      },
    };
  }

  if (directManagementToolNames.has(request.params.name)) {
    return { kind: "call", request };
  }

  return errorResult(
    "Use a permitted built-in management tool directly, or use mcpx_list_servers, mcpx_search_tools, mcpx_get_tool_schema, or mcpx_call_tool for upstream tools on this endpoint.",
  );
}

function projectAnnotations(
  annotations: Tool["annotations"],
): Tool["annotations"] | undefined {
  if (!annotations) return undefined;
  const projected = {
    ...(typeof annotations.title === "string"
      ? { title: annotations.title.slice(0, MAX_DESCRIPTION_LENGTH) }
      : {}),
    ...(typeof annotations.readOnlyHint === "boolean"
      ? { readOnlyHint: annotations.readOnlyHint }
      : {}),
    ...(typeof annotations.destructiveHint === "boolean"
      ? { destructiveHint: annotations.destructiveHint }
      : {}),
    ...(typeof annotations.idempotentHint === "boolean"
      ? { idempotentHint: annotations.idempotentHint }
      : {}),
    ...(typeof annotations.openWorldHint === "boolean"
      ? { openWorldHint: annotations.openWorldHint }
      : {}),
  };
  return Object.keys(projected).length === 0 ? undefined : projected;
}

export function rankToolsLexically(tools: Tool[], query: string): Tool[] {
  const terms = tokenize(query);
  return tools
    .map((tool) => ({ tool, score: scoreTool(tool, query, terms) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .map(({ tool }) => tool);
}

function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .match(/[a-z0-9]+/g) ?? [],
    ),
  ];
}

function scoreTool(tool: Tool, query: string, terms: string[]): number {
  const name = tool.name.toLowerCase();
  if (name === query.toLowerCase()) return 10000;
  if (terms.length === 0) return 0;
  const nameTerms = tokenize(`${tool.name} ${tool.title ?? ""}`);
  const descriptionTerms = tokenize(tool.description ?? "");
  let matched = 0;
  let score = 0;
  for (const term of terms) {
    const nameMatch = nameTerms.some((word) => matchesTerm(word, term));
    const descriptionMatch = descriptionTerms.some((word) =>
      matchesTerm(word, term),
    );
    if (nameMatch || descriptionMatch) {
      matched += 1;
      score += nameMatch ? 10 : 1;
    }
  }
  return matched === 0 ? 0 : score + (matched / terms.length) * 100;
}

function matchesTerm(word: string, term: string): boolean {
  return (
    word === term ||
    (Math.min(word.length, term.length) >= 3 &&
      (word.startsWith(term) || term.startsWith(word)))
  );
}

function jsonResult(value: unknown): LazyRequestResolution {
  return {
    kind: "result",
    result: {
      content: [{ type: "text", text: JSON.stringify(value) }],
    },
  };
}

function invalidArguments(detail: string): LazyRequestResolution {
  return errorResult(`Invalid discovery arguments: ${detail}`);
}

function unavailableTool(): LazyRequestResolution {
  return errorResult("Tool unavailable. Search for an available tool first.");
}

function errorResult(message: string): LazyRequestResolution {
  return {
    kind: "result",
    result: {
      content: [{ type: "text", text: message }],
      isError: true,
    },
  };
}
