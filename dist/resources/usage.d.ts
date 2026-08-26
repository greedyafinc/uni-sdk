import type { Core } from "../core/core.js";
export interface UsagePlan {
    id: number;
    name: string;
    limit: number;
    limit_period_seconds: number;
    monthly_price: number | null;
    annual_price: number | null;
    /**
     * Current subscription term end (ISO), or `null` for Free / no term / a
     * lapsed plan. Already resolved to the effective tier server-side.
     */
    plan_expires_at: string | null;
    /**
     * The instant the term auto-renews — equal to {@link plan_expires_at} while
     * {@link auto_renew} is on, and `null` once the user has cancelled (access
     * then runs out at `plan_expires_at`) or when there is no term.
     */
    renews_at: string | null;
    /** Whether the term extends at its end rather than lapsing to Free. */
    auto_renew: boolean;
}
export interface UsagePeriod {
    input_tokens: number;
    output_tokens: number;
    request_count: number;
    cost: number;
    started_at: string | null;
    resets_at: string;
    days_remaining: number | null;
}
export interface UsageDaily {
    used: number;
    limit: number;
    resets_at: string;
}
export interface UsageCredits {
    /**
     * Persistent prepaid top-up reserve, in USD. Spent automatically once the
     * plan's daily limit is exhausted (a fallback, not part of the limit window).
     * Accrues each subscription period and via rollover of unused daily credits,
     * so unlike the limit window it does not reset. `0` when the user has none.
     */
    balance: number;
}
export interface UsageResponse {
    plan: UsagePlan;
    period: UsagePeriod;
    daily: UsageDaily;
    credits: UsageCredits;
}
export interface GetUsageOptions {
    signal?: AbortSignal;
    /**
     * Aggregation scope. `"app"` (default) returns usage for the calling token's
     * app only. `"account"` returns the user's total across all of their apps —
     * honored only for first-party / own-credential callers (a direct trusted
     * token or `uapi_` key); a third-party OAuth client always stays app-scoped
     * regardless of this value.
     */
    scope?: "app" | "account";
}
export declare class Usage {
    private readonly client;
    constructor(client: Core);
    get(options?: GetUsageOptions): Promise<UsageResponse>;
}
/**
 * Compact count label: 950 → "950", 1_234 → "1.2k", 3_400_000 → "3.4M".
 * Counts are non-negative; non-finite or negative input clamps to "0" rather
 * than emitting a nonsensical "-1.5k".
 */
export declare function formatTokenCount(n: number): string;
/** USD label with two decimals: 1.5 → "$1.50", NaN → "$0.00". */
export declare function formatUsd(n: number): string;
/**
 * Coarse "time until" token (m / h / d) for a future timestamp, or `null` when
 * the target is missing, unparseable, or already in the past. Returns only the
 * short numeric token (e.g. `"5h"`) — the host's i18n layer wraps it in
 * localized wording like "Resets in {x}". `now` is injectable for deterministic
 * rendering and tests (defaults to `Date.now()`).
 *
 * Each unit is floored ("time remaining", not nearest), so the token decreases
 * monotonically as the deadline nears and never rounds *up* across a boundary
 * (e.g. 59m30s reads "59m", not "1h").
 */
export declare function formatTimeUntil(target: string | number | Date | null | undefined, now?: number): string | null;
export interface SummarizeUsageOptions {
    /** Daily ratio at/above which `isNearLimit` is set. Default `0.9`. */
    warnThreshold?: number;
    /** Reference time (epoch ms) for "resets in" tokens. Default `Date.now()`. */
    now?: number;
}
export interface UsageSummaryDaily {
    used: number;
    /** `null` when the plan has no daily cap. */
    limit: number | null;
    usedLabel: string;
    limitLabel: string | null;
    /** Clamped 0..1, or `null` when uncapped. */
    ratio: number | null;
    /** 0..100 integer, or `null` when uncapped. */
    percent: number | null;
    isMetered: boolean;
    isNearLimit: boolean;
    isOverLimit: boolean;
    resetsInLabel: string | null;
}
export interface UsageSummaryPeriod {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    requestCount: number;
    cost: number;
    inputLabel: string;
    outputLabel: string;
    totalLabel: string;
    requestsLabel: string;
    costLabel: string;
    resetsInLabel: string | null;
    daysRemaining: number | null;
}
export interface UsageSummaryCredits {
    balance: number;
    balanceLabel: string;
    hasBalance: boolean;
}
export interface UsageSummarySubscription {
    /** ISO term end, or `null` for Free / no term / lapsed. */
    expiresAt: string | null;
    /** ISO renewal instant (term end while auto-renew is on), else `null`. */
    renewsAt: string | null;
    autoRenew: boolean;
    /** True when there is an active paid term (i.e. `expiresAt` is set). */
    hasTerm: boolean;
    /**
     * Which wording the host should render for the term boundary:
     * `"renews"` (auto-renew on) or `"expires"` (cancelled), or `null` when there
     * is no term. The host pairs it with the localized date of
     * {@link renewsAt}/{@link expiresAt} — e.g. "Renews on {date}".
     */
    status: "renews" | "expires" | null;
    /**
     * Short "time until" token for the term boundary (e.g. `"12d"`), or `null`
     * when there is no future term. Same monotonic flooring as the other
     * `*InLabel` tokens.
     */
    endsInLabel: string | null;
}
export interface UsageSummary {
    planName: string;
    daily: UsageSummaryDaily;
    period: UsageSummaryPeriod;
    credits: UsageSummaryCredits;
    subscription: UsageSummarySubscription;
}
/**
 * Turn a raw {@link UsageResponse} into display-ready fields: compact labels, a
 * clamped daily ratio/percent, near/over-limit flags, and "resets in" tokens.
 * Pure and framework-agnostic — the same view-model can drive a React
 * `<UsageMeter>`, a Vue widget, or a CLI table. Locale-specific wording stays in
 * the host's i18n layer; this only produces values + short numeric/duration
 * tokens.
 */
export declare function summarizeUsage(usage: UsageResponse, options?: SummarizeUsageOptions): UsageSummary;
//# sourceMappingURL=usage.d.ts.map