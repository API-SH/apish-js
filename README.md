# api.sh for JavaScript

Official JavaScript / TypeScript client for [api.sh](https://api.sh?utm_source=github&utm_medium=readme): public web data from around 1,000 websites as clean JSON: search engines, social media, e-commerce, real estate, jobs, travel, news and sports (Google, Amazon, TikTok, Zillow, LinkedIn and more). Every endpoint is a typed method.

```sh
npm i @api.sh/sdk
```

```ts
import { Apish } from "@api.sh/sdk";

const apish = new Apish({ apiKey: process.env.APISH_API_KEY }); // https://app.api.sh/keys

const profile = await apish.tiktok.profile({ username: "nasa" });
console.log(profile.followers, profile.$meta.creditsUsed, profile.$meta.requestId);

const results = await apish.amazon.search({ q: "headphones" }, { raw: false });
```

Node 18+, Deno, Bun, browsers and edge runtimes (anything with `fetch`). No dependencies.

## Calls

- `apish.<platform>.<endpoint>(params, options?)`: one method per endpoint, with typed parameters and the price in its doc comment.
- `apish.call(route, params, options?)`: any route, e.g. `apish.call("/reddit/v1/subreddit", { subreddit: "python" })`.
- Options: `raw: false` (leave out raw source blocks, much smaller), `fields: ["posts.id"]`, `fresh: true` (skip the 24 h cache), `output: "csv" | "ndjson"`, `timeoutMs`, `maxRetries`, `signal`.
- Every result has a non-enumerable `$meta`: `{ requestId, creditsUsed, creditsRemaining, status, ms }`.
- Retries 502/503/504 and network errors with backoff (failed calls are never charged).

## Live catalog: counts, prices and new platforms

The typed methods cover every endpoint that existed when this version was published. The client also reads the
live catalog (free, no credits, cached for an hour), so newer platforms and endpoints work without an upgrade:

```ts
const { platform_count, endpoint_count } = await apish.catalog();   // today's numbers
const prices = await apish.prices();                                 // route -> credits per call, live
await apish.platform("newSite").search({ q: "shoes" });              // a platform added after this release
await apish.hackerNews.someNewEndpoint({ id: "1" });                 // an endpoint added after this release
```

## Pagination

```ts
for await (const page of apish.paginate("/reddit/v1/subreddit", { subreddit: "python" }, { maxPages: 5 })) {
  console.log(page.posts.length);
}
```

## Errors

```ts
import { ApishError } from "@api.sh/sdk";
try { await apish.zillow.property({ url }); }
catch (e) {
  if (e instanceof ApishError) console.log(e.status, e.message, e.insufficientCredits, e.spendLimit, e.requestId);
}
```

## Account (free)

```ts
await apish.account.get();             // balance, plan, spend, limits
await apish.account.usage(30);         // per day
await apish.account.logs({ status: "error" });
await apish.account.result(requestId); // a past response again, free, 30 days
```

## AI agents

```ts
import { openaiTools, anthropicTools, runTool } from "@api.sh/sdk/tools";
const tools = openaiTools();           // apish_search + apish_call
// when the model calls a tool:
const text = await runTool(apish, call.function.name, call.function.arguments);
```

`openaiTools(["/tiktok/v1/profile"])` gives one tool per endpoint instead. For Claude Desktop, Cursor and other MCP clients, use the [MCP server](https://api.sh/mcp?utm_source=github&utm_medium=readme).

Docs: https://api.sh/docs/sdks

## Source and contributions

This repository mirrors the package published on npm. The typed endpoint methods (`src/endpoints.ts`) are generated from the live API.SH catalog, so new platforms appear here with each release. Bug reports, questions and pull requests for the hand-written parts are welcome: open an [issue](../../issues).

## License

MIT
