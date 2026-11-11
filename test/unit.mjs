// Unit tests with a fake fetch (no network). node test/unit.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Apish, ApishError, PAGINATION } from "../dist/esm/index.js";

const calls = [];
const reply = (status, body, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": typeof body === "string" ? "text/csv" : "application/json", ...headers } });
function fake(queue) {
  return async (url, init) => { calls.push({ url: String(url), headers: init.headers }); const next = queue.shift(); if (next instanceof Error) throw next; return next; };
}
let ok = 0;
const test = async (name, fn) => { calls.length = 0; await fn(); ok++; console.log("ok", name); };

await test("typed method builds the URL, sends the key, returns data + $meta", async () => {
  const a = new Apish({ apiKey: "ash_test", fetch: fake([reply(200, { username: "nasa", followers: 1 }, { "x-request-id": "r1", "x-credits-used": "2", "x-credits-remaining": "98" })]) });
  const r = await a.tiktok.profile({ username: "nasa" }, { raw: false, fields: ["username"] });
  assert.equal(r.username, "nasa");
  assert.deepEqual(Object.keys(r), ["username", "followers"]);
  assert.equal(r.$meta.requestId, "r1"); assert.equal(r.$meta.creditsUsed, 2); assert.equal(r.$meta.creditsRemaining, 98);
  const u = new URL(calls[0].url);
  assert.equal(u.origin + u.pathname, "https://api.api.sh/tiktok/v1/profile");
  assert.equal(u.searchParams.get("username"), "nasa"); assert.equal(u.searchParams.get("raw"), "0"); assert.equal(u.searchParams.get("fields"), "username");
  assert.equal(calls[0].headers["x-api-key"], "ash_test");
});

await test("retries 502 then succeeds; never retries 400", async () => {
  const a = new Apish({ apiKey: "k", fetch: fake([reply(502, { success: false, error: "upstream" }), reply(200, { ok: 1 })]) });
  const r = await a.call("/reddit/v1/subreddit", { subreddit: "x" });
  assert.equal(r.ok, 1); assert.equal(calls.length, 2);
  calls.length = 0;
  const b = new Apish({ apiKey: "k", fetch: fake([reply(400, { success: false, error: "missing subreddit" })]) });
  await assert.rejects(b.call("/reddit/v1/subreddit"), (e) => e instanceof ApishError && e.status === 400 && e.message === "missing subreddit");
  assert.equal(calls.length, 1);
});

await test("402 spend limit and insufficient credits are told apart", async () => {
  const a = new Apish({ apiKey: "k", fetch: fake([reply(402, { success: false, error: "daily spend limit reached", spend_limit: "daily" })]) });
  await assert.rejects(a.call("/x"), (e) => e.spendLimit === "daily" && !e.insufficientCredits);
  const b = new Apish({ apiKey: "k", fetch: fake([reply(402, { success: false, error: "insufficient credits", credits_required: 2 })]) });
  await assert.rejects(b.call("/x"), (e) => e.insufficientCredits && e.spendLimit === null);
});

await test("output csv returns text with $meta", async () => {
  const a = new Apish({ apiKey: "k", fetch: fake([reply(200, "a,b\n1,2\n", { "x-request-id": "r2" })]) });
  const r = await a.amazon.search({ q: "x" }, { output: "csv" });
  assert.equal(String(r), "a,b\n1,2\n"); assert.equal(r.$meta.requestId, "r2");
  assert.equal(new URL(calls[0].url).searchParams.get("output"), "csv");
});

await test("paginate follows next_page into page", async () => {
  const route = Object.entries(PAGINATION).find(([, v]) => v.to === "page")[0];
  const a = new Apish({ apiKey: "k", fetch: fake([reply(200, { items: [1], next_page: 2 }), reply(200, { items: [2], next_page: null })]) });
  const pages = []; for await (const p of a.paginate(route, {})) pages.push(p.items[0]);
  assert.deepEqual(pages, [1, 2]); assert.equal(new URL(calls[1].url).searchParams.get("page"), "2");
});

await test("account API paths", async () => {
  const a = new Apish({ apiKey: "k", fetch: fake([reply(200, { success: true }), reply(200, { success: true })]) });
  await a.account.usage(7); await a.account.result("abc-1");
  assert.equal(new URL(calls[0].url).pathname, "/v1/account/usage"); assert.equal(new URL(calls[0].url).searchParams.get("days"), "7");
  assert.equal(new URL(calls[1].url).pathname, "/v1/results/abc-1");
});

await test("network errors retry, then throw", async () => {
  const a = new Apish({ apiKey: "k", maxRetries: 1, fetch: fake([new TypeError("fetch failed"), new TypeError("fetch failed")]) });
  await assert.rejects(a.call("/x"), /fetch failed/); assert.equal(calls.length, 2);
});

const CAT = { version: "v", updated_at: "t", platform_count: 2, endpoint_count: 3, platforms: [
  { slug: "hacker-news", name: "Hacker News", category: "news", endpoints: [{ route: "/hackernews/v1/top", name: "Top", credits: 1 }, { route: "/hackernews/v1/brand-new", name: "New one", credits: 4 }] },
  { slug: "new-site", name: "New Site", category: "x", endpoints: [{ route: "/newsite/v1/search", name: "Search", credits: 2 }] },
] };

await test("live catalog and prices (one fetch, cached)", async () => {
  const a = new Apish({ apiKey: "k", fetch: fake([reply(200, CAT)]) });
  assert.equal((await a.catalog()).endpoint_count, 3);
  assert.equal((await a.prices())["/hackernews/v1/brand-new"], 4);
  assert.equal(calls.length, 1); assert.equal(new URL(calls[0].url).pathname, "/catalog");
});

await test("platforms and endpoints newer than the SDK resolve through the live catalog", async () => {
  const a = new Apish({ apiKey: "k", fetch: fake([reply(200, CAT), reply(200, { items: [] }), reply(200, { ok: 1 })]) });
  await a.hackerNews.brandNew({ id: "1" });
  assert.equal(new URL(calls[1].url).pathname, "/hackernews/v1/brand-new");
  const r = await a.platform("newSite").search({ q: "x" });
  assert.equal(r.ok, 1); assert.equal(new URL(calls[2].url).pathname, "/newsite/v1/search");
  await assert.rejects(a.platform("newSite").nope(), /no endpoint newSite.nope/);
  assert.equal(typeof a.then, "undefined");
});

await test("CommonJS build loads", async () => {
  const require = createRequire(import.meta.url);
  const cjs = require("../dist/cjs/index.js");
  assert.equal(typeof cjs.Apish, "function");
  assert.equal(typeof new cjs.Apish({ apiKey: "k" }).instagram.user, "function");
});
console.log(`${ok} tests passed`);

const tools = await import("../dist/esm/tools.js");
await test("tools: search, formats, runTool", async () => {
  assert.ok(tools.search("tiktok comments", 3)[0].route.startsWith("/tiktok"));
  assert.equal(tools.openaiTools()[1].function.name, "apish_call");
  assert.equal(tools.anthropicTools(["/tiktok/v1/profile"])[0].input_schema.required[0], "username");
  const a = new Apish({ apiKey: "k", fetch: fake([reply(200, { ok: 1 }), reply(200, { ok: 2 })]) });
  assert.equal(await tools.runTool(a, "apish_call", '{"route":"/reddit/v1/subreddit","params":{"subreddit":"x"}}'), '{"ok":1}');
  assert.equal(await tools.runTool(a, "apish_tiktok_profile", { username: "nasa" }), '{"ok":2}');
  assert.equal(new URL(calls[1].url).pathname, "/tiktok/v1/profile");
});
console.log(`${ok} tests passed`);
