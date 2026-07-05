/**
 * Burn-rate estimation from sampled cumulative usage percentages.
 * Pure functions — no vscode dependency — so this stays unit-testable.
 */

export interface Sample {
  /** Epoch milliseconds when the sample was taken. */
  t: number;
  /** Cumulative used percent (0-100) at that time. */
  p: number;
}

export interface PaceResult {
  /** Recent measured burn rate in %/hour (may be negative on sliding windows). */
  ratePerHour: number;
  /** Rate that would exactly exhaust the remaining budget at reset time, %/hour. */
  safeRatePerHour: number;
  /** When 100% is reached at the current rate. Undefined when rate <= 0. */
  projectedHitAt?: Date;
  /** True when the projected hit happens before the window resets. */
  willHitBeforeReset: boolean;
}

const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_SAMPLES = 300;
const HOUR_MS = 60 * 60 * 1000;

/**
 * The burn rate is measured over a span proportional to the limit window, so
 * short windows react to the current session (5h → last 1h) while long windows
 * use a daily average (7d → last 24h) instead of extrapolating a burst.
 */
function rateWindowMs(windowSeconds: number | undefined): number {
  const windowMs = (windowSeconds ?? 5 * 3600) * 1000;
  return Math.min(Math.max(windowMs * 0.2, HOUR_MS), 24 * HOUR_MS);
}

export function appendSample(history: Sample[], sample: Sample): Sample[] {
  const kept = history.filter((s) => sample.t - s.t < HISTORY_RETENTION_MS && s.t < sample.t);
  kept.push(sample);
  return kept.slice(-MAX_SAMPLES);
}

export function computePace(
  history: Sample[],
  resetsAt: Date | undefined,
  now: Date,
  windowSeconds?: number,
): PaceResult | undefined {
  if (!resetsAt) {
    return undefined;
  }
  const nowMs = now.getTime();
  const hoursToReset = (resetsAt.getTime() - nowMs) / 3_600_000;
  if (hoursToReset <= 0) {
    return undefined;
  }

  const measureMs = rateWindowMs(windowSeconds);
  // Below a third of the measurement span the rate estimate is too noisy to act on.
  const minSpanMs = measureMs / 3;
  const recent = history.filter((s) => nowMs - s.t <= measureMs);
  if (recent.length < 2) {
    return undefined;
  }
  const first = recent[0];
  const last = recent[recent.length - 1];
  const spanMs = last.t - first.t;
  if (spanMs < minSpanMs) {
    return undefined;
  }

  const ratePerHour = (last.p - first.p) / (spanMs / 3_600_000);
  const remaining = Math.max(0, 100 - last.p);
  const safeRatePerHour = remaining / hoursToReset;

  if (ratePerHour <= 0) {
    return { ratePerHour, safeRatePerHour, willHitBeforeReset: false };
  }

  const hoursToHit = remaining / ratePerHour;
  const projectedHitAt = new Date(nowMs + hoursToHit * 3_600_000);
  return {
    ratePerHour,
    safeRatePerHour,
    projectedHitAt,
    willHitBeforeReset: projectedHitAt.getTime() < resetsAt.getTime(),
  };
}
