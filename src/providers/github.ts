import { execFileSync } from "child_process";
import { ProviderError, type AccountInfo, type UsageProvider, type UsageSnapshot } from "../types";

const API_BASE = "https://api.github.com";
// The extension host's PATH may not include Homebrew, so try known locations.
const GH_BINARIES = ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];

const DAY = 86400;

export const GITHUB_TOKEN_MISSING_MESSAGE =
  "GitHub token not found. Sign in with the GitHub CLI (gh auth login) or set GH_TOKEN.";
export const GITHUB_SCOPE_MISSING_MESSAGE =
  'The GitHub token is missing the "user" scope required by the billing API. Run: gh auth refresh -h github.com -s user';

function tokenFromGhCli(): string | undefined {
  for (const bin of GH_BINARIES) {
    try {
      const out = execFileSync(bin, ["auth", "token"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      }).trim();
      if (out) {
        return out;
      }
    } catch {
      // Binary missing or not logged in; try the next candidate.
    }
  }
  return undefined;
}

export function resolveGithubToken(
  cliReader: () => string | undefined = tokenFromGhCli,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const token = cliReader() ?? env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (token && token.trim().length > 0) {
    return token.trim();
  }
  throw new ProviderError(GITHUB_TOKEN_MISSING_MESSAGE, "setup");
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Parse the classic GET /users/{u}/settings/billing/actions response. Exported for tests. */
export function snapshotFromClassicBilling(
  body: Record<string, unknown>,
  now: Date,
  resetsAt?: Date,
): UsageSnapshot {
  const used = asNumber(body.total_minutes_used);
  const included = asNumber(body.included_minutes);
  if (used === undefined || included === undefined) {
    throw new ProviderError("GitHub Actions billing response had no minute totals.", "parse");
  }
  const usedPercent = included > 0 ? (used / included) * 100 : used > 0 ? 100 : 0;
  return {
    windows: [
      {
        label: "mo",
        usedPercent,
        resetsAt,
        windowSeconds: 30 * DAY,
        quota: { used: Math.round(used), included: Math.round(included) },
      },
    ],
    fetchedAt: now,
  };
}

/** Windows and macOS jobs consume included minutes at 2x / 10x the Linux rate. */
function skuMultiplier(sku: unknown): number {
  const s = String(sku ?? "").toLowerCase();
  if (s.includes("macos")) {
    return 10;
  }
  if (s.includes("windows")) {
    return 2;
  }
  return 1;
}

/**
 * Sum multiplier-weighted Actions minutes per repository from the enhanced
 * billing platform usage report (GET /users/{u}/settings/billing/usage).
 * Returns undefined when the body has no usageItems array at all; a month with
 * no matching items is legitimately an empty map. The per-repo split matters
 * because public-repo runs are free and do not consume the included quota.
 */
export function actionsMinutesByRepo(body: Record<string, unknown>): Map<string | undefined, number> | undefined {
  const items = body.usageItems;
  if (!Array.isArray(items)) {
    return undefined;
  }
  const perRepo = new Map<string | undefined, number>();
  for (const item of items) {
    const it = item as { product?: unknown; sku?: unknown; unitType?: unknown; quantity?: unknown; repositoryName?: unknown };
    const quantity = asNumber(it.quantity);
    if (quantity === undefined || String(it.product ?? "").toLowerCase() !== "actions") {
      continue;
    }
    if (typeof it.unitType === "string" && !it.unitType.toLowerCase().includes("minute")) {
      continue;
    }
    const repo = typeof it.repositoryName === "string" && it.repositoryName.length > 0 ? it.repositoryName : undefined;
    perRepo.set(repo, (perRepo.get(repo) ?? 0) + quantity * skuMultiplier(it.sku));
  }
  return perRepo;
}

/** Monthly included Actions minutes by plan, for accounts on the enhanced billing platform. */
export function includedMinutesForPlan(plan: string | undefined): number {
  switch ((plan ?? "").toLowerCase()) {
    case "pro":
    case "team":
      return 3000;
    case "enterprise":
      return 50000;
    default:
      return 2000; // free
  }
}

/** The metered usage report is aggregated per calendar month (UTC). */
export function nextMonthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

interface GithubResponse {
  ok: boolean;
  status: number;
  /** Classic-token scopes from x-oauth-scopes; absent for fine-grained tokens. */
  scopes?: string;
  rateLimited: boolean;
  body: unknown;
}

function hasUserScope(scopes: string | undefined): boolean | undefined {
  if (scopes === undefined) {
    return undefined;
  }
  return scopes
    .split(",")
    .map((s) => s.trim())
    .includes("user");
}

export class GithubProvider implements UsageProvider {
  readonly id = "github";
  readonly shortName = "GH";
  readonly displayName = "GitHub Actions";

  /** Override for the included-minutes quota; 0 means derive it from the account plan. */
  constructor(private readonly includedMinutesOverride: () => number = () => 0) {}

  /** Visibility rarely changes, so successful lookups are cached for the session. */
  private readonly publicRepoCache = new Map<string, boolean>();

  private async repoIsPublic(owner: string, repo: string, token: string): Promise<boolean> {
    const full = repo.includes("/") ? repo : `${owner}/${repo}`;
    const cached = this.publicRepoCache.get(full);
    if (cached !== undefined) {
      return cached;
    }
    const res = await this.request(`/repos/${full}`, token);
    if (!res.ok) {
      // Deleted/renamed/inaccessible: count its minutes so the gauge never understates usage.
      return false;
    }
    const isPublic = (res.body as { private?: boolean }).private === false;
    this.publicRepoCache.set(full, isPublic);
    return isPublic;
  }

  private async request(pathname: string, token: string): Promise<GithubResponse> {
    const res = await fetch(`${API_BASE}${pathname}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "llm-usage-bar",
      },
    });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return {
      ok: res.ok,
      status: res.status,
      scopes: res.headers.get("x-oauth-scopes") ?? undefined,
      rateLimited: res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0"),
      body,
    };
  }

  private errorFor(res: GithubResponse, what: string): ProviderError {
    if (res.status === 401) {
      return new ProviderError(
        "GitHub API returned 401. The token may be revoked — run gh auth login again.",
        "not-logged-in",
      );
    }
    if (res.rateLimited) {
      return new ProviderError("GitHub API is rate limited.", "rate-limited");
    }
    return new ProviderError(`GitHub ${what} API returned HTTP ${res.status}.`, "http");
  }

  async fetchUsage(): Promise<UsageSnapshot> {
    const token = resolveGithubToken();
    const userRes = await this.request("/user", token);
    if (!userRes.ok) {
      throw this.errorFor(userRes, "user");
    }
    const profile = userRes.body as {
      login?: string;
      name?: string | null;
      email?: string | null;
      plan?: { name?: string } | null;
    };
    if (!profile.login) {
      throw new ProviderError("GitHub /user response had no login.", "parse");
    }
    const account: AccountInfo = {
      displayName: profile.name ?? profile.login,
      email: profile.email ?? undefined,
    };
    const planName = profile.plan?.name;
    const now = new Date();

    // Preferred: the classic billing endpoint reports used and included minutes directly.
    const billing = await this.request(`/users/${profile.login}/settings/billing/actions`, token);
    if (billing.ok) {
      let resetsAt: Date | undefined;
      const storage = await this.request(`/users/${profile.login}/settings/billing/shared-storage`, token);
      if (storage.ok) {
        const days = asNumber((storage.body as Record<string, unknown>).days_left_in_billing_cycle);
        if (days !== undefined) {
          resetsAt = new Date(now.getTime() + days * DAY * 1000);
        }
      }
      return {
        ...snapshotFromClassicBilling(billing.body as Record<string, unknown>, now, resetsAt),
        plan: planName,
        account,
      };
    }
    if (billing.status === 401 || billing.rateLimited) {
      throw this.errorFor(billing, "Actions billing");
    }

    // Classic OAuth tokens without the "user" scope get a 404 here; that is a
    // fixable setup problem, not an API failure — tell the user the exact command.
    if (hasUserScope(billing.scopes) === false) {
      throw new ProviderError(GITHUB_SCOPE_MISSING_MESSAGE, "setup");
    }

    // Accounts migrated to the enhanced billing platform lose the classic
    // endpoint; fall back to summing Actions minutes from the usage report.
    const usage = await this.request(
      `/users/${profile.login}/settings/billing/usage?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`,
      token,
    );
    if (!usage.ok) {
      throw this.errorFor(usage, "billing usage");
    }
    const byRepo = actionsMinutesByRepo(usage.body as Record<string, unknown>);
    if (byRepo === undefined) {
      throw new ProviderError("GitHub billing usage response had no usageItems.", "parse");
    }
    // Only private-repo minutes draw down the included quota; public-repo runs are free.
    const counted = await Promise.all(
      [...byRepo.entries()].map(async ([repo, m]) =>
        repo !== undefined && (await this.repoIsPublic(profile.login!, repo, token)) ? 0 : m,
      ),
    );
    const minutes = counted.reduce((a, b) => a + b, 0);
    const override = this.includedMinutesOverride();
    const included = override > 0 ? override : includedMinutesForPlan(planName);
    return {
      windows: [
        {
          label: "mo",
          usedPercent: included > 0 ? (minutes / included) * 100 : 0,
          resetsAt: nextMonthStartUtc(now),
          windowSeconds: 30 * DAY,
          quota: { used: Math.round(minutes), included },
        },
      ],
      plan: planName,
      account,
      fetchedAt: now,
    };
  }
}
