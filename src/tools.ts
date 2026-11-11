/**
 * api.sh as tools for AI agents (OpenAI / Anthropic function calling, Vercel AI SDK, LangChain.js, …).
 * Two generic tools keep prompts short: apish_search (find an endpoint) and apish_call (run it).
 *
 *   import { Apish } from "@api.sh/sdk";
 *   import { openaiTools, runTool } from "@api.sh/sdk/tools";
 *   const tools = openaiTools();
 *   const text = await runTool(apish, call.function.name, call.function.arguments);
 */
import { ENDPOINTS, type EndpointInfo } from "./endpoints.js";
import type { Apish } from "./index.js";

const MAX_CHARS = 60_000;
export interface ToolDef { name: string; description: string; parameters: Record<string, any>; route?: string }

const SEARCH: ToolDef = {
  name: "apish_search",
  description: "Search the api.sh catalog of public-web data endpoints (around 1,000 websites: search engines, social media, e-commerce, real estate, jobs, travel, news and sports) by keywords. Returns routes, what they return, their parameters and credit price.",
  parameters: { type: "object", properties: { query: { type: "string", description: "Keywords, e.g. 'tiktok comments' or 'zillow property'" }, limit: { type: "integer", description: "Max results (default 10)" } }, required: ["query"] },
};
const CALL: ToolDef = {
  name: "apish_call",
  description: "Run an api.sh endpoint found with apish_search and return its JSON. Costs the endpoint's credits on success; failed calls are free. Bulky raw source blocks are left out.",
  parameters: { type: "object", properties: { route: { type: "string", description: "The route, e.g. /reddit/v1/subreddit" }, params: { type: "object", description: "Query parameters, e.g. {\"subreddit\": \"python\"}" } }, required: ["route"] },
};

/** Endpoints matching the keywords, best first. */
export function search(query: string, limit = 10): EndpointInfo[] {
  const words = query.toLowerCase().split(/\W+/).filter(Boolean);
  return ENDPOINTS.map((e) => {
    const hay = `${e.platform} ${e.route} ${e.summary}`.toLowerCase();
    const score = words.reduce((t, w) => t + (hay.includes(w) ? (e.platform.toLowerCase().includes(w) || e.route.includes(w) ? 3 : 1) : 0), 0);
    return { e, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(50, limit))).map((x) => x.e);
}

const toolName = (route: string) => `apish_${route.replace("/v1/", "/").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 56)}`;

/** One tool per route (name, description, JSON-schema parameters). */
export function endpointTools(routes: string[]): ToolDef[] {
  return routes.map((r) => {
    const e = ENDPOINTS.find((x) => x.route === r);
    if (!e) throw new Error(`unknown route ${r}`);
    const properties = Object.fromEntries(e.params.map((p) => [p.name, { type: p.type === "integer" || p.type === "number" || p.type === "boolean" ? p.type : "string", description: p.description || p.name, ...(p.enum ? { enum: p.enum } : {}) }]));
    return { name: toolName(r), description: `${e.platform}: ${e.summary} (${e.credits} credits per call)`, parameters: { type: "object", properties, required: e.params.filter((p) => p.required).map((p) => p.name) }, route: r };
  });
}

/** OpenAI function-calling tools. Default: apish_search + apish_call. */
export function openaiTools(routes?: string[]) {
  return (routes ? endpointTools(routes) : [SEARCH, CALL]).map(({ name, description, parameters }) => ({ type: "function" as const, function: { name, description, parameters } }));
}

/** Anthropic Messages API tools. Default: apish_search + apish_call. */
export function anthropicTools(routes?: string[]) {
  return (routes ? endpointTools(routes) : [SEARCH, CALL]).map(({ name, description, parameters }) => ({ name, description, input_schema: parameters }));
}

/** Runs a tool call from the model and returns the text for the tool result. */
export async function runTool(client: Apish, name: string, args: unknown): Promise<string> {
  const a = (typeof args === "string" ? JSON.parse(args || "{}") : args || {}) as Record<string, any>;
  if (name === "apish_search") return JSON.stringify(search(String(a.query || ""), Number(a.limit) || 10));
  let route: string; let params: Record<string, unknown>;
  if (name === "apish_call") { route = String(a.route || ""); params = a.params || {}; }
  else {
    const e = ENDPOINTS.find((x) => toolName(x.route) === name);
    if (!e) return JSON.stringify({ error: `unknown tool ${name}` });
    route = e.route; params = a;
  }
  try {
    const res = await client.call(route, params, { raw: false });
    const text = typeof res === "object" && !(res instanceof String) ? JSON.stringify(res) : String(res);
    return text.length <= MAX_CHARS ? text : `${text.slice(0, MAX_CHARS)}… (truncated: ask for fewer results or use the fields option)`;
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message });
  }
}
