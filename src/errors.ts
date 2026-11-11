/** An error answered by api.sh (4xx/5xx). Failed calls are never charged. */
export class ApishError extends Error {
  /** HTTP status: 400 bad input, 401 bad key, 402 out of credits or spend limit, 404 not found, 502 source failed, 503 paused. */
  readonly status: number;
  readonly requestId: string | null;
  /** The JSON error body, e.g. { success: false, error, credits_required, spend_limit, resets_at }. */
  readonly body: Record<string, any>;
  constructor(status: number, message: string, body: Record<string, any> = {}, requestId: string | null = null) {
    super(message);
    this.name = "ApishError";
    this.status = status;
    this.body = body;
    this.requestId = requestId;
  }
  /** 402 because the account has too few credits. */
  get insufficientCredits(): boolean { return this.status === 402 && !this.body.spend_limit; }
  /** 402 because a spend limit you set was reached ("daily" | "monthly"). */
  get spendLimit(): string | null { return this.status === 402 ? this.body.spend_limit ?? null : null; }
  /** Worth retrying later (the source site failed, or the endpoint is paused). */
  get retryable(): boolean { return this.status === 502 || this.status === 503 || this.status === 504; }
}
