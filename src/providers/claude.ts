import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { ProviderError, type UsageProvider, type UsageSnapshot, type UsageWindow } from "../types";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    expiresAt?: number;
  };
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

function readAccessToken(): string {
  return readAccessTokenFromSources(candidateCredentialPaths());
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

/** Parse the /api/oauth/usage response body. Exported for tests. */
export function parseClaudeUsage(body: Record<string, unknown>, now: Date): UsageSnapshot {
  const windows: UsageWindow[] = [];
  for (const { key, label, seconds } of WINDOW_KEYS) {
    const bucket = body[key] as UsageBucket | null | undefined;
    if (!bucket || typeof bucket.utilization !== "number") {
      continue;
    }
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
    const token = readAccessToken();
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
    return parseClaudeUsage(body, new Date());
  }
}
