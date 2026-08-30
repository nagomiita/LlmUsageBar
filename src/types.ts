export interface UsageWindow {
  /** Short label like "5h", "7d", "7d Opus", "mo" */
  label: string;
  usedPercent: number;
  resetsAt?: Date;
  /** Length of the limit window, used to scale burn-rate measurement. */
  windowSeconds?: number;
  /** Absolute quantities behind usedPercent (e.g. GitHub Actions minutes). */
  quota?: { used: number; included: number };
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

export interface AccountInfo {
  displayName?: string;
  email?: string;
  organization?: string;
}

export interface UsageSnapshot {
  windows: UsageWindow[];
  plan?: string;
  /** Present only when the account actually has credits / extra usage enabled. */
  credits?: CreditInfo;
  /** Human-readable identity from the CLI's local login metadata. */
  account?: AccountInfo;
  fetchedAt: Date;
}

/** "setup" carries a self-contained, user-actionable message shown verbatim (after l10n lookup). */
export type ProviderErrorKind = "not-logged-in" | "rate-limited" | "http" | "parse" | "setup";

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
