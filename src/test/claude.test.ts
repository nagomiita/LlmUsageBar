import { test } from "node:test";
import * as assert from "node:assert/strict";
import { parseClaudeUsage } from "../providers/claude";
import { ProviderError } from "../types";

const NOW = new Date("2026-07-05T04:00:00Z");

// Shape observed live from GET https://api.anthropic.com/api/oauth/usage (2026-07-05).
function fixture() {
  return {
    five_hour: { utilization: 30, resets_at: "2026-07-05T06:29:59.836Z" },
    seven_day: { utilization: 50, resets_at: "2026-07-10T15:59:59.836Z" },
    seven_day_opus: null,
  };
}

test("parses five_hour and seven_day windows", () => {
  const snap = parseClaudeUsage(fixture(), NOW);
  assert.equal(snap.windows.length, 2);
  assert.deepEqual(
    snap.windows.map((w) => [w.label, w.usedPercent]),
    [
      ["5h", 30],
      ["7d", 50],
    ],
  );
  assert.equal(snap.windows[0].resetsAt?.toISOString(), "2026-07-05T06:29:59.836Z");
  assert.equal(snap.fetchedAt, NOW);
});

test("skips null and malformed buckets", () => {
  const snap = parseClaudeUsage(
    {
      five_hour: { utilization: 12 },
      seven_day: { utilization: "bad" },
      seven_day_opus: null,
    },
    NOW,
  );
  assert.equal(snap.windows.length, 1);
  assert.equal(snap.windows[0].label, "5h");
  assert.equal(snap.windows[0].resetsAt, undefined);
});

test("throws parse error when no windows are recognizable", () => {
  assert.throws(
    () => parseClaudeUsage({ unexpected: true }, NOW),
    (e: unknown) => e instanceof ProviderError && e.kind === "parse",
  );
});
