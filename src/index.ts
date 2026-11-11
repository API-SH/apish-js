import { ApishError } from "./errors.js";
import { CREDITS, PAGINATION, Platforms } from "./endpoints.js";
import type { ApishResult, CallMeta, CallOptions } from "./types.js";

export { ApishError } from "./errors.js";
export type { ApishResult, CallMeta, CallOptions } from "./types.js";
export * from "./endpoints.js";

export interface ApishOptions {
  /** Your API key (https://app.api.sh/keys). Default: process.env.APISH_API_KEY. */
  apiKey?: string;
  /** Default: https://api.api.sh */
  baseUrl?: string;
  /** Per-call timeout in ms. Default 120000: some endpoints take up to a minute. */
  timeoutMs?: number;
  /** Retries on 502/503/504 and network errors, with backoff (honours retry-after). Default 2. */
  maxRetries?: number;
  /** A custom fetch (tests, custom networking). Default: globalThis.fetch. */
  fetch?: typeof fetch;
}

const VERSION = "0.3.2";
declare const process: { env: Record<string, string | undefined> } | undefined;
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});

/**
 * The api.sh client.
 *
 *   const apish = new Apish({ apiKey: process.env.APISH_API_KEY });
 *   const profile = await apish.tiktok.profile({ username: "nasa" });
 *   console.log(profile.followers, profile.$meta.creditsUsed);
 */
export class Apish extends Platforms {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  /** Your balance, usage, logs and past responses (free). */
  readonly account: {
    /** Credits by bucket, plan, spend today / this month, spend limits. */
    get: () => Promise<ApishResult>;
    /** Calls, errors and credits per UTC day (1-90 days) and the top endpoints. */
    usage: (days?: number) => Promise<ApishResult>;
    /** Calls of the last 30 days, newest first; page with { before: result.next }. */
    logs: (query?: { limit?: number; status?: string; route?: string; key?: string; since?: string; before?: string }) => Promise<ApishResult>;
    /** The response of an earlier call (its request id) again, free, for 30 days. */
    result: (requestId: string, options?: Pick<CallOptions, "output" | "records">) => Promise<ApishResult>;
  };

  constructor(options: ApishOptions = {}) {
    const self = { call: null as unknown as (r: string, p: Record<string, unknown>, o?: CallOptions) => Promise<ApishResult> };
    super((r, p, o) => self.call(r, p, o));
    self.call = (r, p, o) => this.call(r, p, o);
    const env = typeof process !== "undefined" ? process.env : {};
    this.apiKey = options.apiKey ?? env.APISH_API_KEY ?? "";
    if (!this.apiKey) throw new Error("api.sh: pass { apiKey } or set APISH_API_KEY (create a key at https://app.api.sh/keys)");
    this.baseUrl = (options.baseUrl ?? "https://api.api.sh").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.account = {
      get: () => this.call("/v1/account", {}),
      usage: (days = 30) => this.call("/v1/account/usage", { days }),
      logs: (query = {}) => this.call("/v1/account/logs", query),
      result: (requestId, o) => this.call(`/v1/results/${encodeURIComponent(requestId)}`, {}, o),
    };
    // platforms and endpoints added after this SDK version still work: apish.newsite.search({...}) finds its
    // route in the live catalog (typed methods cover everything that existed when the SDK was published)
    const dynamic = (ns: string, target: object = {}) => new Proxy(target, {
      get: (t, m, r) => (typeof m !== "string" || m in t || m === "then" ? Reflect.get(t, m, r) : async (params: Record<string, unknown> = {}, o?: CallOptions) => {
        const route = await this.resolve(ns, m);
        if (!route) throw new Error(`api.sh: no endpoint ${ns}.${m} (see https://api.sh/catalog)`);
        return this.call(route, params, o);
      }),
    });
    for (const k of Object.keys(this)) {
      const v = (this as Record<string, unknown>)[k];
      if (v && typeof v === "object" && v.constructor?.name?.endsWith("Api")) (this as Record<string, unknown>)[k] = dynamic(k, v);
    }
    return new Proxy(this, {
      get: (t, k, r) => (typeof k !== "string" || k in t || k === "then" || k.startsWith("_") ? Reflect.get(t, k, r) : dynamic(k)),
    });
  }

  /** Credits per successful call for a route, as of this SDK version (live prices: await apish.prices()). */
  static credits(route: string): number | undefined { return CREDITS[route]; }

  // initialised so the property exists on the instance (the client wrapper treats unknown names as platforms)
  private live: { at: number; data: Promise<LiveCatalog> } | undefined = undefined;

  /**
   * The live catalog (free, no credits): platform and endpoint counts, every platform and its endpoints with
   * today's price. Cached for an hour.
   *   const { platform_count, endpoint_count } = await apish.catalog();
   */
  catalog(options: { refresh?: boolean } = {}): Promise<LiveCatalog> {
    if (!this.live || options.refresh || Date.now() - this.live.at > 3_600_000) {
      const data = this.fetchImpl(`${this.baseUrl}/catalog`, { headers: { "user-agent": `apish-js/${VERSION}`, accept: "application/json" } })
        .then(async (r) => { if (!r.ok) throw new ApishError(r.status, `api.sh catalog returned ${r.status}`, {}, null); return (await r.json()) as LiveCatalog; });
      data.catch(() => { this.live = undefined; });
      this.live = { at: Date.now(), data };
    }
    return this.live.data;
  }

  /** route -> credits per successful call, live. */
  async prices(): Promise<Record<string, number>> {
    const c = await this.catalog();
    return Object.fromEntries(c.platforms.flatMap((p) => p.endpoints.map((e) => [e.route, e.credits])));
  }

  /**
   * A platform by its property name, typed loosely: for platforms added after this SDK version (TypeScript doesn't
   * know their methods yet). await apish.platform("newsite").search({ q: "..." })
   */
  platform(name: string): Record<string, (params?: Record<string, unknown>, options?: CallOptions) => Promise<ApishResult>> {
    return (this as unknown as Record<string, any>)[name];
  }

  /** The route behind apish.<platform>.<method>() for platforms and endpoints newer than this SDK version. */
  async resolve(platform: string, method: string): Promise<string | undefined> {
    const c = await this.catalog();
    for (const p of c.platforms) {
      if (camel(p.slug) !== platform) continue;
      return methodNames(p.endpoints.map((e) => e.route)).find(([, m]) => m === method)?.[0];
    }
    return undefined;
  }

  /** Calls any endpoint by route: apish.call("/reddit/v1/subreddit", { subreddit: "python" }). */
  async call(route: string, params: Record<string, unknown> = {}, options: CallOptions = {}): Promise<ApishResult> {
    const url = new URL(this.baseUrl + route);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    if (options.raw !== undefined) url.searchParams.set("raw", options.raw ? "1" : "0");
    if (options.fields) url.searchParams.set("fields", Array.isArray(options.fields) ? options.fields.join(",") : options.fields);
    if (options.fresh) url.searchParams.set("fresh", "1");
    if (options.output && options.output !== "json") url.searchParams.set("output", options.output);
    if (options.records) url.searchParams.set("records", options.records);
    const retries = options.maxRetries ?? this.maxRetries;
    const t0 = Date.now();
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error(`api.sh: no answer in ${options.timeoutMs ?? this.timeoutMs} ms`)), options.timeoutMs ?? this.timeoutMs);
      const onAbort = () => ctrl.abort(options.signal!.reason);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      let res: Response;
      try {
        res = await this.fetchImpl(url, { headers: { "x-api-key": this.apiKey, "user-agent": `apish-js/${VERSION}`, accept: "application/json" }, signal: ctrl.signal });
      } catch (err) {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (options.signal?.aborted || attempt >= retries) throw err;
        await sleep(backoff(attempt), options.signal);
        continue;
      }
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const meta: CallMeta = {
        requestId: res.headers.get("x-request-id"),
        creditsUsed: Number(res.headers.get("x-credits-used") || 0),
        creditsRemaining: res.headers.get("x-credits-remaining") === null ? null : Number(res.headers.get("x-credits-remaining")),
        status: res.status,
        ms: Date.now() - t0,
      };
      const type = res.headers.get("content-type") || "";
      if (res.ok && !type.includes("json")) {
        const text = new String(await res.text());
        Object.defineProperty(text, "$meta", { value: meta });
        return text as unknown as ApishResult;
      }
      const body = (await res.json().catch(() => ({}))) as Record<string, any>;
      if (res.ok) {
        const out = Array.isArray(body) ? { items: body } : body;
        Object.defineProperty(out, "$meta", { value: meta, enumerable: false });
        return out as ApishResult;
      }
      const err = new ApishError(res.status, String(body.error || body.message || `api.sh returned ${res.status}`), body, meta.requestId);
      if (!err.retryable || attempt >= retries) throw err;
      const after = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 30_000) : backoff(attempt), options.signal);
    }
  }

  /**
   * Every page of a paginated endpoint, one response at a time:
   *   for await (const page of apish.paginate("/reddit/v1/subreddit", { subreddit: "python" }, { maxPages: 5 })) …
   */
  async *paginate(route: string, params: Record<string, unknown> = {}, options: CallOptions & { maxPages?: number } = {}): AsyncGenerator<ApishResult> {
    const rule = PAGINATION[route];
    let p = { ...params };
    for (let n = 0; n < (options.maxPages ?? Infinity); n++) {
      const page = await this.call(route, p, options);
      yield page;
      const next = rule ? page[rule.from] : undefined;
      if (!rule || next === undefined || next === null || next === "" || next === false) return;
      p = { ...p, [rule.to]: next };
    }
  }
}

/** The live catalog (GET /catalog). */
export interface LiveCatalog {
  version: string;
  updated_at: string;
  platform_count: number;
  endpoint_count: number;
  platforms: Array<{ slug: string; name: string; category: string; domains?: string[]; endpoints: Array<{ route: string; name: string; credits: number; takes_url?: boolean }> }>;
}

// method names exactly as the generated endpoint code names them, so dynamic calls match the typed ones
const words = (s: string) => s.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
const lead = (w: string[]) => (/^\d/.test(w[0] || "") ? ["site", ...w] : w);
const camel = (s: string) => lead(words(s)).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join("");
function methodNames(routes: string[]): Array<[string, string]> {
  const parts = routes.map((r) => { const segs = r.split("/").filter(Boolean); return { r, first: segs[0], tail: segs.slice(1).filter((x) => x !== "v1").join("-") || segs[0] }; });
  const tally = new Map<string, number>();
  for (const p of parts) tally.set(camel(p.tail), (tally.get(camel(p.tail)) || 0) + 1);
  return parts.map((p) => [p.r, (tally.get(camel(p.tail)) || 0) > 1 ? camel(`${p.first}-${p.tail}`) : camel(p.tail)]);
}

function backoff(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 10_000) + Math.floor(Math.random() * 250);
}

export default Apish;
