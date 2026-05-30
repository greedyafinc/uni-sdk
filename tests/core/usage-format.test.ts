import { describe, expect, test } from "bun:test";
import {
  type UsageResponse,
  formatTimeUntil,
  formatTokenCount,
  formatUsd,
  summarizeUsage,
} from "../../src/resources/usage";

const NOW = 1_700_000_000_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function makeUsage(overrides: Partial<UsageResponse> = {}): UsageResponse {
  return {
    plan: {
      id: 2,
      name: "Pro",
      limit: 1_000_000,
      limit_period_seconds: 2_592_000,
      monthly_price: 20,
      annual_price: 200,
    },
    period: {
      input_tokens: 12_340,
      output_tokens: 5_600,
      request_count: 142,
      cost: 3.5,
      started_at: iso(-5 * 24 * 3600_000),
      resets_at: iso(25 * 24 * 3600_000),
      days_remaining: 25,
    },
    daily: { used: 9_500, limit: 10_000, resets_at: iso(5 * 3600_000) },
    credits: { balance: 4 },
    ...overrides,
  };
}

describe("formatTokenCount", () => {
  test("formats small, k, and M ranges", () => {
    expect(formatTokenCount(950)).toBe("950");
    expect(formatTokenCount(1_234)).toBe("1.2k");
    expect(formatTokenCount(12_345)).toBe("12k");
    expect(formatTokenCount(3_400_000)).toBe("3.4M");
    expect(formatTokenCount(0)).toBe("0");
  });
  test("clamps non-finite and negative input to 0", () => {
    expect(formatTokenCount(Number.NaN)).toBe("0");
    expect(formatTokenCount(Number.POSITIVE_INFINITY)).toBe("0");
    expect(formatTokenCount(-1500)).toBe("0");
    expect(formatTokenCount(-1)).toBe("0");
  });
});

describe("formatUsd", () => {
  test("two-decimal dollars", () => {
    expect(formatUsd(1.5)).toBe("$1.50");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(Number.NaN)).toBe("$0.00");
  });
});

describe("formatTimeUntil", () => {
  test("returns m / h / d tokens for future times", () => {
    expect(formatTimeUntil(iso(30 * 60_000), NOW)).toBe("30m");
    expect(formatTimeUntil(iso(5 * 3600_000), NOW)).toBe("5h");
    expect(formatTimeUntil(iso(3 * 24 * 3600_000), NOW)).toBe("3d");
  });
  test("returns null for past, missing, or invalid input", () => {
    expect(formatTimeUntil(iso(-1000), NOW)).toBeNull();
    expect(formatTimeUntil(null, NOW)).toBeNull();
    expect(formatTimeUntil("not-a-date", NOW)).toBeNull();
  });
  test("floors each unit (never rounds up across a boundary)", () => {
    // 59m30s remaining reads "59m", not "1h".
    expect(formatTimeUntil(iso(59 * 60_000 + 30_000), NOW)).toBe("59m");
    // 1h59m reads "1h"; 23h59m reads "23h".
    expect(formatTimeUntil(iso(60 * 60_000 + 59 * 60_000), NOW)).toBe("1h");
    expect(formatTimeUntil(iso(23 * 3600_000 + 59 * 60_000), NOW)).toBe("23h");
    // 1d23h reads "1d".
    expect(formatTimeUntil(iso(47 * 3600_000), NOW)).toBe("1d");
  });
});

describe("summarizeUsage", () => {
  test("builds a display-ready view-model for a metered plan", () => {
    const s = summarizeUsage(makeUsage(), { now: NOW });
    expect(s.planName).toBe("Pro");
    expect(s.daily.isMetered).toBe(true);
    expect(s.daily.ratio).toBeCloseTo(0.95, 5);
    expect(s.daily.percent).toBe(95);
    expect(s.daily.isNearLimit).toBe(true); // 0.95 >= default 0.9
    expect(s.daily.isOverLimit).toBe(false);
    expect(s.daily.usedLabel).toBe("9.5k");
    expect(s.daily.limitLabel).toBe("10k");
    expect(s.daily.resetsInLabel).toBe("5h");
    expect(s.period.totalTokens).toBe(17_940);
    expect(s.period.costLabel).toBe("$3.50");
    expect(s.credits.balanceLabel).toBe("$4.00");
    expect(s.credits.hasBalance).toBe(true);
  });

  test("treats a zero daily limit as unmetered", () => {
    const s = summarizeUsage(
      makeUsage({ daily: { used: 500, limit: 0, resets_at: iso(3600_000) } }),
      {
        now: NOW,
      },
    );
    expect(s.daily.isMetered).toBe(false);
    expect(s.daily.limit).toBeNull();
    expect(s.daily.ratio).toBeNull();
    expect(s.daily.percent).toBeNull();
    expect(s.daily.isNearLimit).toBe(false);
  });

  test("clamps over-limit usage and flags it", () => {
    const s = summarizeUsage(
      makeUsage({ daily: { used: 12_000, limit: 10_000, resets_at: iso(3600_000) } }),
      { now: NOW },
    );
    expect(s.daily.ratio).toBe(1);
    expect(s.daily.percent).toBe(100);
    expect(s.daily.isOverLimit).toBe(true);
    expect(s.daily.isNearLimit).toBe(true);
  });

  test("honors a custom warnThreshold", () => {
    const s = summarizeUsage(
      makeUsage({ daily: { used: 8_000, limit: 10_000, resets_at: iso(3600_000) } }),
      {
        now: NOW,
        warnThreshold: 0.75,
      },
    );
    expect(s.daily.ratio).toBeCloseTo(0.8, 5);
    expect(s.daily.isNearLimit).toBe(true); // 0.8 >= 0.75
  });

  test("surfaces a non-zero balance, including negative (owed/refund)", () => {
    const zero = summarizeUsage(makeUsage({ credits: { balance: 0 } }), { now: NOW });
    expect(zero.credits.hasBalance).toBe(false);

    const neg = summarizeUsage(makeUsage({ credits: { balance: -5 } }), { now: NOW });
    expect(neg.credits.hasBalance).toBe(true);
    expect(neg.credits.balanceLabel).toBe("$-5.00");
  });
});
