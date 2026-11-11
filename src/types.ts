/** Options for one call (on top of the endpoint's own parameters). */
export interface CallOptions {
  /** 0 leaves out the bulky `raw` source blocks (often 10-30x smaller). Default: the API default (included). */
  raw?: boolean;
  /** Only these fields, e.g. ["posts.id", "posts.title"]. Call metadata is always included. */
  fields?: string[] | string;
  /** Skip the 24-hour cache and fetch live. */
  fresh?: boolean;
  /** "csv" or "ndjson" returns the response's records as text instead of JSON. */
  output?: "json" | "csv" | "ndjson";
  /** With output csv/ndjson: which top-level list becomes the rows ("." = the whole object as one row). */
  records?: string;
  /** Per-call timeout in ms (default: the client's, 120 s). */
  timeoutMs?: number;
  /** Retries on 502/503/504 and network errors (default: the client's, 2). Failed calls are never charged. */
  maxRetries?: number;
  signal?: AbortSignal;
}

/** Facts about the call, from response headers. */
export interface CallMeta {
  requestId: string | null;
  creditsUsed: number;
  creditsRemaining: number | null;
  status: number;
  /** Time the call took, including retries, in ms. */
  ms: number;
}

/** A JSON response (its fields), with the call's metadata under the non-enumerable `$meta`. */
export type ApishResult = Record<string, any> & { readonly $meta: CallMeta };

export type Caller = (route: string, params: Record<string, unknown>, options?: CallOptions) => Promise<ApishResult>;
