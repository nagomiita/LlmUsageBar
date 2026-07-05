export interface UsageWindow {
  /** Short label like "5h", "7d", "7d Opus" */
  label: string;
  usedPercent: number;
  resetsAt?: Date;
  /** Length of the limit window, used to scale burn-rate measurement. */
  windowSeconds?: number;
}

export interface CreditInfo {
  /** Used / limit amounts in minor currency units (e.g. cents), for Claude extra usage. */
  usedMinor?: number;
  limitMinor?: number;
  exponent?: number;
  currency?: string;
  /** Remaining credit balance, for Codex. */
  balance?: string;
  unlimited?: boolean;
}

export interface UsageSnapshot {
  windows: UsageWindow[];
  plan?: string;
  /** Present only when the account actually has credits / extra usage enabled. */
  credits?: CreditInfo;
  fetchedAt: Date;
}

export type ProviderErrorKind = "not-logged-in" | "rate-limited" | "http" | "parse";

export class ProviderError extends Error {
  constructor(message: string, public readonly kind: ProviderErrorKind) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface UsageProvider {
  /** Stable id, also used as settings key segment: "claude" | "codex" */
  readonly id: string;
  /** Short name shown in the status bar, e.g. "CC" */
  readonly shortName: string;
  readonly displayName: string;
  /** Floor for the poll interval, for APIs with strict rate limits. */
  readonly minPollIntervalSeconds?: number;
  fetchUsage(): Promise<UsageSnapshot>;
}
