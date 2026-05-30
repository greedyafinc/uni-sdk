import type { Core, RequestOptions } from "../core/core";

export interface UsagePlan {
  id: number;
  name: string;
  limit: number;
  limit_period_seconds: number;
  monthly_price: number | null;
  annual_price: number | null;
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
}

export class Usage {
  constructor(private readonly client: Core) {}

  get(options: GetUsageOptions = {}): Promise<UsageResponse> {
    const req: RequestOptions = { method: "GET" };
    if (options.signal) req.signal = options.signal;
    return this.client.request<UsageResponse>("/api/v1/usage", req);
  }
}

// ─── Display helpers ────────────────────────────────────────────────────────
//
// Pure, framework-agnostic formatting + a view-model builder so every host
// (React, Vue, a CLI, the desktop app) renders usage consistently without
// re-deriving the same math. These power the optional UI packages
// (see UI-COMPONENTS-PLAN.md) and can be used directly by any custom UI.

/**
 * Compact count label: 950 → "950", 1_234 → "1.2k", 3_400_000 → "3.4M".
 * Counts are non-negative; non-finite or negative input clamps to "0" rather
 * than emitting a nonsensical "-1.5k".
 */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

/** USD label with two decimals: 1.5 → "$1.50", NaN → "$0.00". */
export function formatUsd(n: number): string {
  return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
}

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
export function formatTimeUntil(
  target: string | number | Date | null | undefined,
  now: number = Date.now(),
): string | null {
  if (target == null) return null;
  const t = target instanceof Date ? target.getTime() : new Date(target).getTime();
  if (!Number.isFinite(t)) return null;
  const ms = t - now;
  if (ms <= 0) return null;
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

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

export interface UsageSummary {
  planName: string;
  daily: UsageSummaryDaily;
  period: UsageSummaryPeriod;
  credits: UsageSummaryCredits;
}

/**
 * Turn a raw {@link UsageResponse} into display-ready fields: compact labels, a
 * clamped daily ratio/percent, near/over-limit flags, and "resets in" tokens.
 * Pure and framework-agnostic — the same view-model can drive a React
 * `<UsageMeter>`, a Vue widget, or a CLI table. Locale-specific wording stays in
 * the host's i18n layer; this only produces values + short numeric/duration
 * tokens.
 */
export function summarizeUsage(
  usage: UsageResponse,
  options: SummarizeUsageOptions = {},
): UsageSummary {
  const warnThreshold = options.warnThreshold ?? 0.9;
  const now = options.now ?? Date.now();
  const { plan, period, daily, credits } = usage;

  const dailyMetered = daily.limit > 0;
  const ratio = dailyMetered ? Math.min(1, Math.max(0, daily.used / daily.limit)) : null;
  const totalTokens = period.input_tokens + period.output_tokens;

  return {
    planName: plan.name,
    daily: {
      used: daily.used,
      limit: dailyMetered ? daily.limit : null,
      usedLabel: formatTokenCount(daily.used),
      limitLabel: dailyMetered ? formatTokenCount(daily.limit) : null,
      ratio,
      percent: ratio === null ? null : Math.round(ratio * 100),
      isMetered: dailyMetered,
      isNearLimit: ratio !== null && ratio >= warnThreshold,
      isOverLimit: ratio !== null && ratio >= 1,
      resetsInLabel: formatTimeUntil(daily.resets_at, now),
    },
    period: {
      inputTokens: period.input_tokens,
      outputTokens: period.output_tokens,
      totalTokens,
      requestCount: period.request_count,
      cost: period.cost,
      inputLabel: formatTokenCount(period.input_tokens),
      outputLabel: formatTokenCount(period.output_tokens),
      totalLabel: formatTokenCount(totalTokens),
      requestsLabel: formatTokenCount(period.request_count),
      costLabel: formatUsd(period.cost),
      resetsInLabel: formatTimeUntil(period.resets_at, now),
      daysRemaining: period.days_remaining,
    },
    credits: {
      balance: credits.balance,
      balanceLabel: formatUsd(credits.balance),
      // Any non-zero balance is worth surfacing — including a negative one
      // (e.g. an owed / refund state), which formatUsd renders as "$-X.XX".
      hasBalance: credits.balance !== 0,
    },
  };
}
