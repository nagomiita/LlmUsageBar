import { test } from "node:test";
import * as assert from "node:assert/strict";
import { parseCodexUsage } from "../providers/codex";
import { ProviderError } from "../types";

const NOW = new Date("2026-07-05T04:00:00Z");

// Shape observed live from GET https://chatgpt.com/backend-api/wham/usage (2026-07-05).
// Note: the key is `rate_limit` (singular), unlike CodexBar's docs which say `rate_limits`.
function fixture() {
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 47,
        limit_window_seconds: 18000,
        reset_after_seconds: 9353,
        reset_at: 1783234647,
      },
      secondary_window: {
        used_percent: 62,
        limit_window_seconds: 604800,
        reset_after_seconds: 173126,
        reset_at: 1783398420,
      },
    },
  };
}

test("parses primary and secondary windows from rate_limit (singular)", () => {
  const snap = parseCodexUsage(fixture(), NOW);
  assert.deepEqual(
    snap.windows.map((w) => [w.label, w.usedPercent]),
    [
      ["5h", 47],
      ["7d", 62],
    ],
  );
  assert.equal(snap.windows[0].resetsAt?.getTime(), 1783234647 * 1000);
  assert.equal(snap.plan, "plus");
});

test("labels are derived from limit_window_seconds", () => {
  const body = fixture();
  body.rate_limit.primary_window.limit_window_seconds = 3600;
  body.rate_limit.secondary_window.limit_window_seconds = 30 * 86400;
  const snap = parseCodexUsage(body, NOW);
  assert.deepEqual(
    snap.windows.map((w) => w.label),
    ["1h", "30d"],
  );
});

test("supports legacy rate_limits plural and primary/secondary keys", () => {
  const snap = parseCodexUsage(
    {
      rate_limits: {
        primary: { used_percent: 10, window_minutes: 300, resets_in_seconds: 600 },
        secondary: { used_percent: 20, window_minutes: 10080 },
      },
    },
    NOW,
  );
  assert.deepEqual(
    snap.windows.map((w) => [w.label, w.usedPercent]),
    [
      ["5h", 10],
      ["7d", 20],
    ],
  );
  assert.equal(snap.windows[0].resetsAt?.getTime(), NOW.getTime() + 600 * 1000);
  assert.equal(snap.windows[1].resetsAt, undefined);
});

test("parses credits only when they exist", () => {
  const none = { ...fixture(), credits: { has_credits: false, unlimited: false, balance: "0" } };
  assert.equal(parseCodexUsage(none, NOW).credits, undefined);

  const some = { ...fixture(), credits: { has_credits: true, unlimited: false, balance: "1250" } };
  assert.deepEqual(parseCodexUsage(some, NOW).credits, { balance: "1250" });

  const unlimited = { ...fixture(), credits: { has_credits: true, unlimited: true } };
  assert.deepEqual(parseCodexUsage(unlimited, NOW).credits, { unlimited: true });
});

test("throws parse error when no windows are recognizable", () => {
  assert.throws(
    () => parseCodexUsage({ rate_limit: {} }, NOW),
    (e: unknown) => e instanceof ProviderError && e.kind === "parse",
  );
});
