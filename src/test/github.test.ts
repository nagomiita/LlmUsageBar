import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  actionsMinutesByRepo,
  includedMinutesForPlan,
  nextMonthStartUtc,
  resolveGithubToken,
  snapshotFromClassicBilling,
} from "../providers/github";
import { ProviderError } from "../types";

const NOW = new Date("2026-08-30T04:00:00Z");

test("parses the classic Actions billing response", () => {
  const resetsAt = new Date("2026-09-11T04:00:00Z");
  const snap = snapshotFromClassicBilling(
    {
      total_minutes_used: 305,
      total_paid_minutes_used: 0,
      included_minutes: 3000,
      minutes_used_breakdown: { UBUNTU: 205, MACOS: 10, WINDOWS: 90 },
    },
    NOW,
    resetsAt,
  );
  assert.equal(snap.windows.length, 1);
  const w = snap.windows[0];
  assert.equal(w.label, "mo");
  assert.equal(Math.round(w.usedPercent * 100) / 100, 10.17);
  assert.deepEqual(w.quota, { used: 305, included: 3000 });
  assert.equal(w.resetsAt, resetsAt);
  assert.equal(snap.fetchedAt, NOW);
});

test("throws parse error when the billing response has no minute totals", () => {
  assert.throws(
    () => snapshotFromClassicBilling({ unexpected: true }, NOW),
    (e: unknown) => e instanceof ProviderError && e.kind === "parse",
  );
});

test("sums Actions minutes per repo with OS multipliers from usage items", () => {
  const byRepo = actionsMinutesByRepo({
    usageItems: [
      { product: "Actions", sku: "Actions Linux", unitType: "minutes", quantity: 100, repositoryName: "a/priv" },
      { product: "actions", sku: "Actions macOS", unitType: "Minutes", quantity: 5, repositoryName: "a/priv" },
      { product: "Actions", sku: "Actions Windows", unitType: "minutes", quantity: 10, repositoryName: "b/pub" },
      { product: "Actions", sku: "Actions storage", unitType: "GigabyteHours", quantity: 999, repositoryName: "a/priv" },
      { product: "Copilot", unitType: "requests", quantity: 50 },
      { product: "Actions", unitType: "minutes", quantity: "bad", repositoryName: "a/priv" },
      { product: "Actions", sku: "Actions Linux", unitType: "minutes", quantity: 7 },
    ],
  });
  assert.deepEqual(
    [...byRepo!.entries()],
    [
      ["a/priv", 150], // 100 Linux + 5 macOS × 10
      ["b/pub", 20], // 10 Windows × 2
      [undefined, 7], // no repositoryName — still counted by the provider
    ],
  );
});

test("usage items: empty month is an empty map, missing usageItems is unrecognizable", () => {
  assert.equal(actionsMinutesByRepo({ usageItems: [] })!.size, 0);
  assert.equal(actionsMinutesByRepo({ unexpected: true }), undefined);
});

test("derives included minutes from the account plan", () => {
  assert.equal(includedMinutesForPlan("free"), 2000);
  assert.equal(includedMinutesForPlan("pro"), 3000);
  assert.equal(includedMinutesForPlan(undefined), 2000);
});

test("computes the next UTC month start for the usage report window", () => {
  assert.equal(nextMonthStartUtc(NOW).toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(nextMonthStartUtc(new Date("2026-12-15T00:00:00Z")).toISOString(), "2027-01-01T00:00:00.000Z");
});

test("resolves the GitHub token from the gh CLI first, then env", () => {
  assert.equal(resolveGithubToken(() => "cli-token", { GH_TOKEN: "env-token" }), "cli-token");
  assert.equal(resolveGithubToken(() => undefined, { GH_TOKEN: "env-token" }), "env-token");
  assert.equal(resolveGithubToken(() => undefined, { GITHUB_TOKEN: "env-token-2" }), "env-token-2");
});

test("throws a setup error when no GitHub token is available", () => {
  assert.throws(
    () => resolveGithubToken(() => undefined, {}),
    (e: unknown) => e instanceof ProviderError && e.kind === "setup",
  );
});
