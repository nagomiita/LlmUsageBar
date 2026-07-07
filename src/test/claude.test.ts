import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseClaudeUsage, readAccessTokenFromPaths, readAccessTokenFromSources } from "../providers/claude";
import { ProviderError } from "../types";

const NOW = new Date("2026-07-05T04:00:00Z");

// Shape observed live from GET https://api.anthropic.com/api/oauth/usage (2026-07-05).
function fixture() {
  return {
    five_hour: { utilization: 30, resets_at: "2026-07-05T06:29:59.836Z" },
    seven_day: { utilization: 50, resets_at: "2026-07-10T15:59:59.836Z" },
    seven_day_opus: null,
  };
}

test("parses five_hour and seven_day windows", () => {
  const snap = parseClaudeUsage(fixture(), NOW);
  assert.equal(snap.windows.length, 2);
  assert.deepEqual(
    snap.windows.map((w) => [w.label, w.usedPercent]),
    [
      ["5h", 30],
      ["7d", 50],
    ],
  );
  assert.equal(snap.windows[0].resetsAt?.toISOString(), "2026-07-05T06:29:59.836Z");
  assert.equal(snap.fetchedAt, NOW);
});

test("skips null and malformed buckets", () => {
  const snap = parseClaudeUsage(
    {
      five_hour: { utilization: 12 },
      seven_day: { utilization: "bad" },
      seven_day_opus: null,
    },
    NOW,
  );
  assert.equal(snap.windows.length, 1);
  assert.equal(snap.windows[0].label, "5h");
  assert.equal(snap.windows[0].resetsAt, undefined);
});

test("parses extra usage credits when enabled", () => {
  const body = {
    ...fixture(),
    extra_usage: {
      is_enabled: true,
      monthly_limit: 10000,
      used_credits: 91,
      utilization: 0.91,
      currency: "USD",
      decimal_places: 2,
    },
  };
  const snap = parseClaudeUsage(body, NOW);
  assert.deepEqual(snap.credits, { usedMinor: 91, limitMinor: 10000, exponent: 2, currency: "USD" });
});

test("omits credits when extra usage is disabled or absent", () => {
  assert.equal(parseClaudeUsage(fixture(), NOW).credits, undefined);
  const disabled = { ...fixture(), extra_usage: { is_enabled: false, monthly_limit: 10000, used_credits: 0 } };
  assert.equal(parseClaudeUsage(disabled, NOW).credits, undefined);
});

test("throws parse error when no windows are recognizable", () => {
  assert.throws(
    () => parseClaudeUsage({ unexpected: true }, NOW),
    (e: unknown) => e instanceof ProviderError && e.kind === "parse",
  );
});

test("reads access token from current Claude Code config file shape", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-usage-bar-claude-"));
  const config = path.join(dir, ".claude.json");
  fs.writeFileSync(config, JSON.stringify({ oauth: { claudeAiOauth: { accessToken: "new-token" } } }));

  assert.equal(readAccessTokenFromPaths([config]), "new-token");
});

test("falls back to legacy Claude credentials file shape", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-usage-bar-claude-"));
  const missingCurrent = path.join(dir, ".claude.json");
  const legacy = path.join(dir, ".claude", ".credentials.json");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ claudeAiOauth: { accessToken: "legacy-token" } }));

  assert.equal(readAccessTokenFromPaths([missingCurrent, legacy]), "legacy-token");
});

test("throws not-logged-in when Claude token is absent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-usage-bar-claude-"));
  const config = path.join(dir, ".claude.json");
  fs.writeFileSync(config, JSON.stringify({ oauth: {} }));

  assert.throws(
    () => readAccessTokenFromPaths([config]),
    (e: unknown) => e instanceof ProviderError && e.kind === "not-logged-in",
  );
});

test("reads access token from macOS Claude Code keychain payload fallback", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-usage-bar-claude-"));
  const missingCurrent = path.join(dir, ".claude.json");
  const missingLegacy = path.join(dir, ".claude", ".credentials.json");
  const keychainPayload = JSON.stringify({
    claudeAiOauth: {
      accessToken: "keychain-token",
      refreshToken: "keychain-refresh",
      expiresAt: Date.now() + 3600_000,
    },
  });

  assert.equal(readAccessTokenFromSources([missingCurrent, missingLegacy], () => keychainPayload), "keychain-token");
});

test("ignores malformed Claude keychain payload and reports not-logged-in", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-usage-bar-claude-"));
  const missingCurrent = path.join(dir, ".claude.json");
  const missingLegacy = path.join(dir, ".claude", ".credentials.json");

  assert.throws(
    () => readAccessTokenFromSources([missingCurrent, missingLegacy], () => "not json"),
    (e: unknown) => e instanceof ProviderError && e.kind === "not-logged-in",
  );
});
