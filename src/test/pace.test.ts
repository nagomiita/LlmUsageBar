import { test } from "node:test";
import * as assert from "node:assert/strict";
import { appendSample, computePace, type Sample } from "../pace";

const H = 3_600_000;
const NOW = new Date("2026-07-05T12:00:00Z");

function samples(...pairs: Array<[minutesAgo: number, percent: number]>): Sample[] {
  return pairs.map(([m, p]) => ({ t: NOW.getTime() - m * 60_000, p })).sort((a, b) => a.t - b.t);
}

test("appendSample drops entries older than 24h and caps size", () => {
  let history: Sample[] = [{ t: NOW.getTime() - 25 * H, p: 1 }];
  history = appendSample(history, { t: NOW.getTime(), p: 50 });
  assert.equal(history.length, 1);
  assert.equal(history[0].p, 50);
});

test("flags when current pace hits the limit before reset", () => {
  // 60% used, burning 20%/h measured over the last hour, reset in 4h.
  // Remaining 40% at 20%/h → hit in 2h, well before reset.
  const history = samples([60, 40], [30, 50], [0, 60]);
  const pace = computePace(history, new Date(NOW.getTime() + 4 * H), NOW);
  assert.ok(pace);
  assert.equal(Math.round(pace.ratePerHour), 20);
  assert.equal(pace.safeRatePerHour, 10);
  assert.equal(pace.willHitBeforeReset, true);
  assert.equal(pace.projectedHitAt?.getTime(), NOW.getTime() + 2 * H);
});

test("safe when reset comes before the projected hit", () => {
  // 30% used, 5%/h → hit in 14h, but reset in 2h.
  const history = samples([60, 25], [0, 30]);
  const pace = computePace(history, new Date(NOW.getTime() + 2 * H), NOW);
  assert.ok(pace);
  assert.equal(pace.willHitBeforeReset, false);
  assert.ok(pace.projectedHitAt);
});

test("negative rate (sliding window draining) is safe with no projection", () => {
  const history = samples([50, 70], [0, 60]);
  const pace = computePace(history, new Date(NOW.getTime() + 3 * H), NOW);
  assert.ok(pace);
  assert.ok(pace.ratePerHour < 0);
  assert.equal(pace.willHitBeforeReset, false);
  assert.equal(pace.projectedHitAt, undefined);
});

test("returns undefined when the sample span is too short to judge", () => {
  const history = samples([10, 50], [0, 55]);
  assert.equal(computePace(history, new Date(NOW.getTime() + 3 * H), NOW), undefined);
});

const SEVEN_DAYS = 7 * 24 * 3600;

test("7d window measures over the last 24h (daily rate), not the last hour", () => {
  // Steady 0.5%/h over 20h (12%/day). A last-hour-only measurement would see the
  // same rate, but the point is the 20h span is accepted for a 7d window.
  const history = samples([1200, 30], [600, 35], [0, 40]);
  const pace = computePace(history, new Date(NOW.getTime() + 72 * H), NOW, SEVEN_DAYS);
  assert.ok(pace);
  assert.equal(pace.ratePerHour.toFixed(2), "0.50");
  // Remaining 60% at 0.5%/h → 120h to hit, reset in 72h → safe.
  assert.equal(pace.willHitBeforeReset, false);
});

test("7d window rejects spans shorter than 8h as too noisy", () => {
  // 1h of samples is enough for a 5h window but not for a 7d window.
  const history = samples([60, 40], [30, 50], [0, 60]);
  assert.ok(computePace(history, new Date(NOW.getTime() + 72 * H), NOW, 5 * 3600));
  assert.equal(computePace(history, new Date(NOW.getTime() + 72 * H), NOW, SEVEN_DAYS), undefined);
});

test("returns undefined without a reset time or after reset", () => {
  const history = samples([60, 40], [0, 60]);
  assert.equal(computePace(history, undefined, NOW), undefined);
  assert.equal(computePace(history, new Date(NOW.getTime() - 1000), NOW), undefined);
});
