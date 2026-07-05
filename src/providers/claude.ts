import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ProviderError, type UsageProvider, type UsageSnapshot, type UsageWindow } from "../types";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    expiresAt?: number;
  };
}

function readAccessToken(): string {
  const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
  let raw: string;
  try {
    raw = fs.readFileSync(credPath, "utf8");
  } catch {
    throw new ProviderError(
      `Claude credentials not found at ${credPath}. Log in with the Claude Code CLI first.`,
      "not-logged-in",
    );
  }
  const creds = JSON.parse(raw) as ClaudeCredentials;
  const token = creds.claudeAiOauth?.accessToken;
  if (!token) {
    throw new ProviderError("No accessToken in Claude credentials file.", "not-logged-in");
  }
  return token;
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
