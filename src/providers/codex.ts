import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ProviderError, type UsageProvider, type UsageSnapshot, type UsageWindow } from "../types";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

interface CodexAuth {
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
}

function readAuth(): { accessToken: string; accountId?: string } {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const authPath = path.join(codexHome, "auth.json");
  let raw: string;
  try {
    raw = fs.readFileSync(authPath, "utf8");
  } catch {
    throw new ProviderError(
      `Codex auth not found at ${authPath}. Log in with the Codex CLI first.`,
      "not-logged-in",
    );
  }
  const auth = JSON.parse(raw) as CodexAuth;
  const accessToken = auth.tokens?.access_token;
  if (!accessToken) {
    throw new ProviderError("No access_token in Codex auth.json.", "not-logged-in");
  }
  return { accessToken, accountId: auth.tokens?.account_id };
}

interface RateWindow {
  used_percent?: number;
  reset_at?: number; // unix seconds
  resets_in_seconds?: number;
  limit_window_seconds?: number;
  window_minutes?: number;
}

function windowLabel(w: RateWindow, fallback: string): string {
  const seconds =
    w.limit_window_seconds ?? (typeof w.window_minutes === "number" ? w.window_minutes * 60 : undefined);
  if (!seconds) {
    return fallback;
  }
  const hours = seconds / 3600;
  return hours <= 24 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
}

function windowReset(w: RateWindow, now: Date): Date | undefined {
  if (typeof w.reset_at === "number") {
    return new Date(w.reset_at * 1000);
  }
  if (typeof w.resets_in_seconds === "number") {
    return new Date(now.getTime() + w.resets_in_seconds * 1000);
  }
  return undefined;
}

/** Parse the wham/usage response body. Exported for tests. */
export function parseCodexUsage(body: Record<string, unknown>, now: Date): UsageSnapshot {
  const rateLimits = (body.rate_limit ?? body.rate_limits ?? body) as Record<string, RateWindow | undefined>;
  const candidates: Array<{ w: RateWindow | undefined; fallback: string }> = [
    { w: rateLimits.primary_window ?? rateLimits.primary, fallback: "5h" },
    { w: rateLimits.secondary_window ?? rateLimits.secondary, fallback: "7d" },
  ];

  const windows: UsageWindow[] = [];
  for (const { w, fallback } of candidates) {
    if (!w || typeof w.used_percent !== "number") {
      continue;
    }
    const seconds =
      w.limit_window_seconds ?? (typeof w.window_minutes === "number" ? w.window_minutes * 60 : undefined);
    windows.push({
      label: windowLabel(w, fallback),
      usedPercent: w.used_percent,
      resetsAt: windowReset(w, now),
      windowSeconds: seconds,
    });
  }
  if (windows.length === 0) {
    throw new ProviderError("Codex usage API response had no recognizable rate-limit windows.", "parse");
  }

  let plan: string | undefined;
  if (typeof body.plan_type === "string") {
    plan = body.plan_type;
  }

  let credits: UsageSnapshot["credits"];
  const rawCredits = body.credits as
    | { has_credits?: boolean; unlimited?: boolean; balance?: string | number }
    | null
    | undefined;
  if (rawCredits?.unlimited) {
    credits = { unlimited: true };
  } else if (rawCredits && (rawCredits.has_credits || Number(rawCredits.balance) > 0)) {
    credits = { balance: String(rawCredits.balance ?? "") };
  }
  return { windows, plan, credits, fetchedAt: now };
}

export class CodexProvider implements UsageProvider {
  readonly id = "codex";
  readonly shortName = "CX";
  readonly displayName = "Codex";

  async fetchUsage(): Promise<UsageSnapshot> {
    const { accessToken, accountId } = readAuth();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "codex-cli",
    };
    if (accountId) {
      headers["ChatGPT-Account-Id"] = accountId;
    }
    const res = await fetch(USAGE_URL, { headers });
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError(
        `Codex usage API returned ${res.status}. Token may be expired — run the Codex CLI once to refresh it.`,
        "not-logged-in",
      );
    }
    if (res.status === 429) {
      throw new ProviderError("Codex usage API is rate limited.", "rate-limited");
    }
    if (!res.ok) {
      throw new ProviderError(`Codex usage API returned HTTP ${res.status}.`, "http");
    }
    const body = (await res.json()) as Record<string, unknown>;
    return parseCodexUsage(body, new Date());
  }
}
