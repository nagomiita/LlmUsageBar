import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { ProviderError, type AccountInfo, type UsageProvider, type UsageSnapshot, type UsageWindow } from "../types";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    expiresAt?: number;
  };
}

interface ClaudeLogin {
  accessToken: string;
  account?: AccountInfo;
}

function candidateCredentialPaths(): string[] {
  const home = os.homedir();
  return [
    // Current Claude Code stores the OAuth session in this global config file.
    path.join(home, ".claude.json"),
    // Older Claude Code builds used this separate credentials file.
    path.join(home, ".claude", ".credentials.json"),
  ];
}

function findAccessToken(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  const direct = obj.accessToken;
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  const oauth = obj.claudeAiOauth;
  if (oauth && typeof oauth === "object") {
    const token = (oauth as ClaudeCredentials["claudeAiOauth"])?.accessToken;
    if (typeof token === "string" && token.length > 0) {
      return token;
    }
  }
  for (const child of Object.values(obj)) {
    const token = findAccessToken(child);
    if (token) {
      return token;
    }
  }
  return undefined;
}

/** Read the user-facing identity cached by Claude Code alongside its OAuth session. */
export function accountFromClaudeConfig(value: unknown): AccountInfo | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const oauthAccount = (value as Record<string, unknown>).oauthAccount;
  if (!oauthAccount || typeof oauthAccount !== "object") {
    return undefined;
  }
  const raw = oauthAccount as Record<string, unknown>;
  const stringValue = (key: string) => {
    const candidate = raw[key];
    return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : undefined;
  };
  const displayName = stringValue("displayName");
  const email = stringValue("emailAddress");
  const organization = stringValue("organizationName");
  return displayName || email || organization ? { displayName, email, organization } : undefined;
}

function readAccountFromPaths(paths: string[]): AccountInfo | undefined {
  for (const credPath of paths) {
    try {
      const account = accountFromClaudeConfig(JSON.parse(fs.readFileSync(credPath, "utf8")) as unknown);
      if (account) {
        return account;
      }
    } catch {
      // Account metadata is optional; token lookup reports authentication failures.
    }
  }
  return undefined;
}

export function readAccessTokenFromPaths(paths: string[]): string {
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const credPath of paths) {
    let raw: string;
    try {
      raw = fs.readFileSync(credPath, "utf8");
    } catch {
      missing.push(credPath);
      continue;
    }
    let creds: unknown;
    try {
      creds = JSON.parse(raw) as ClaudeCredentials;
    } catch {
      invalid.push(credPath);
      continue;
    }
    const token = findAccessToken(creds);
    if (token) {
      return token;
    }
    invalid.push(credPath);
  }
  const searched = [...missing, ...invalid].join(", ");
  throw new ProviderError(
    `Claude OAuth token not found. Searched: ${searched}. Log in with the Claude Code CLI first.`,
    "not-logged-in",
  );
}

function readClaudeKeychainPayload(): string | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }
  try {
    return execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      },
    ).trim();
  } catch {
    return undefined;
  }
}

export function readAccessTokenFromSources(
  paths: string[],
  keychainReader: () => string | undefined = readClaudeKeychainPayload,
): string {
  try {
    return readAccessTokenFromPaths(paths);
  } catch (fileError) {
    const payload = keychainReader();
    if (payload) {
      try {
        const token = findAccessToken(JSON.parse(payload) as unknown);
        if (token) {
          return token;
        }
      } catch {
        // Fall through to the file error, which includes the searched paths.
      }
    }
    if (fileError instanceof ProviderError) {
      throw fileError;
    }
    throw new ProviderError("Claude OAuth token not found.", "not-logged-in");
  }
}

export function readLoginFromSources(
  paths: string[],
  keychainReader: () => string | undefined = readClaudeKeychainPayload,
): ClaudeLogin {
  // Claude Code may split the token (Keychain) and profile metadata (~/.claude.json).
  return {
    accessToken: readAccessTokenFromSources(paths, keychainReader),
    account: readAccountFromPaths(paths),
  };
}

function readLogin(): ClaudeLogin {
  return readLoginFromSources(candidateCredentialPaths());
}

interface UsageBucket {
  utilization?: number;
  resets_at?: string;
}

const DAY = 86400;
const WINDOW_KEYS: Array<{ key: string; label: string; seconds: number }> = [
  { key: "five_hour", label: "5h", seconds: 5 * 3600 },
  { key: "seven_day", label: "7d", seconds: 7 * DAY },
  { key: "seven_day_sonnet", label: "7d Sonnet", seconds: 7 * DAY },
  { key: "seven_day_opus", label: "7d Opus", seconds: 7 * DAY },
  { key: "seven_day_oauth_apps", label: "7d Apps", seconds: 7 * DAY },
];

interface LimitEntry {
  kind?: string;
  group?: string;
  percent?: number;
  resets_at?: string | null;
  scope?: { model?: { display_name?: string | null } | null } | null;
}

/**
 * The newer response shape lists every limit (including per-model scoped ones
 * like the Fable weekly cap) in a `limits` array; the legacy top-level buckets
 * only cover a fixed set of window keys.
 */
function windowFromLimit(entry: LimitEntry): UsageWindow | undefined {
  if (typeof entry.percent !== "number") {
    return undefined;
  }
  const kind = entry.kind ?? "";
  const group = entry.group ?? "";
  let base: { label: string; seconds?: number };
  if (kind === "session" || group === "session") {
    base = { label: "5h", seconds: 5 * 3600 };
  } else if (group === "weekly" || kind.startsWith("weekly")) {
    base = { label: "7d", seconds: 7 * DAY };
  } else if (group === "monthly" || kind.startsWith("monthly")) {
    base = { label: "30d", seconds: 30 * DAY };
  } else if (kind || group) {
    base = { label: kind || group };
  } else {
    return undefined;
  }
  const scopeName = entry.scope?.model?.display_name;
  return {
    label: scopeName ? `${base.label} ${scopeName}` : base.label,
    usedPercent: entry.percent,
    resetsAt: entry.resets_at ? new Date(entry.resets_at) : undefined,
    windowSeconds: base.seconds,
  };
}

/** Parse the /api/oauth/usage response body. Exported for tests. */
export function parseClaudeUsage(body: Record<string, unknown>, now: Date): UsageSnapshot {
  const windows: UsageWindow[] = [];
  const seen = new Set<string>();
  const limits = body.limits;
  if (Array.isArray(limits)) {
    for (const entry of limits) {
      const window = windowFromLimit(entry as LimitEntry);
      if (window && !seen.has(window.label)) {
        seen.add(window.label);
        windows.push(window);
      }
    }
  }
  // Legacy buckets fill in anything the limits array didn't cover (and are the
  // only source on older API responses).
  for (const { key, label, seconds } of WINDOW_KEYS) {
    const bucket = body[key] as UsageBucket | null | undefined;
    if (!bucket || typeof bucket.utilization !== "number" || seen.has(label)) {
      continue;
    }
    seen.add(label);
    windows.push({
      label,
      usedPercent: bucket.utilization,
      resetsAt: bucket.resets_at ? new Date(bucket.resets_at) : undefined,
      windowSeconds: seconds,
    });
  }
  if (windows.length === 0) {
    throw new ProviderError("Claude usage API response had no recognizable windows.", "parse");
  }
  // Short windows first, and the plain window before model-scoped ones of the
  // same length ("5h", "7d", "7d Fable", …) regardless of which source
  // contributed them; ties keep API order.
  windows.sort(
    (a, b) =>
      (a.windowSeconds ?? Number.MAX_SAFE_INTEGER) - (b.windowSeconds ?? Number.MAX_SAFE_INTEGER) ||
      Number(a.label.includes(" ")) - Number(b.label.includes(" ")),
  );

  // "Extra usage" credits cover overflow beyond the plan limits when enabled.
  let credits: UsageSnapshot["credits"];
  const extra = body.extra_usage as
    | { is_enabled?: boolean; monthly_limit?: number; used_credits?: number; currency?: string; decimal_places?: number }
    | null
    | undefined;
  if (extra?.is_enabled && typeof extra.monthly_limit === "number" && typeof extra.used_credits === "number") {
    credits = {
      usedMinor: extra.used_credits,
      limitMinor: extra.monthly_limit,
      exponent: extra.decimal_places ?? 2,
      currency: extra.currency,
    };
  }
  return { windows, credits, fetchedAt: now };
}

export class ClaudeProvider implements UsageProvider {
  readonly id = "claude";
  readonly shortName = "CC";
  readonly displayName = "Claude";
  // The oauth/usage endpoint rate-limits aggressively (429s observed even at
  // 5-minute polling, likely shared with Claude Code's own traffic).
  readonly minPollIntervalSeconds = 600;

  async fetchUsage(): Promise<UsageSnapshot> {
    const { accessToken: token, account } = readLogin();
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
    });
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError(
        `Claude usage API returned ${res.status}. Token may be expired — run the Claude CLI once to refresh it.`,
        "not-logged-in",
      );
    }
    if (res.status === 429) {
      throw new ProviderError("Claude usage API is rate limited.", "rate-limited");
    }
    if (!res.ok) {
      throw new ProviderError(`Claude usage API returned HTTP ${res.status}.`, "http");
    }
    const body = (await res.json()) as Record<string, unknown>;
    return { ...parseClaudeUsage(body, new Date()), account };
  }
}
