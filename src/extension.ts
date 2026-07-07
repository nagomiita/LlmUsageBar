import * as vscode from "vscode";
import { ClaudeProvider } from "./providers/claude";
import { CodexProvider } from "./providers/codex";
import { ProviderError, type UsageProvider, type UsageSnapshot } from "./types";
import { appendSample, computePace, type PaceResult, type Sample } from "./pace";
import { displayWidth, renderBar, renderGaugeLine } from "./gauge";
import {
  readCooldownUntil,
  readSharedCache,
  releaseFetchLock,
  tryAcquireFetchLock,
  writeCooldown,
  writeSharedCache,
} from "./sharedCache";
import { checkForUpdatesInBackground, installLatestRelease } from "./update/githubRelease";
import { estimateSessionCost } from "./cost";

const CONFIG_SECTION = "llmUsageBar";

/** Format a token count compactly: 235923 → "236k", 1_500_000 → "1.5M". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${Math.round(n / 1000)}k`;
  }
  return String(n);
}

/**
 * Append a metered-cost estimate for the active Claude Code session, read from
 * the local transcript. This is workspace-specific and independent of the usage
 * API, so it's computed at render time rather than flowing through the cache.
 */
function appendSessionCost(md: vscode.MarkdownString): void {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  if (!config.get<boolean>("claude.showSessionCost", true)) {
    return;
  }
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspacePath) {
    return;
  }
  const cost = estimateSessionCost(workspacePath);
  if (!cost) {
    return;
  }
  md.appendMarkdown(
    `$(dashboard) ${vscode.l10n.t(
      "Metered estimate — context {0} tokens, session ~${1}",
      formatTokens(cost.contextTokens),
      cost.costUsd.toFixed(2),
    )}\n\n`,
  );
}

interface ProviderState {
  provider: UsageProvider;
  item: vscode.StatusBarItem;
  snapshot?: UsageSnapshot;
  lastError?: Error;
  consecutiveFailures: number;
  /** Poll ticks to skip before retrying after failures (exponential backoff). */
  skipTicks: number;
  /** Last fetch attempt, for per-provider interval floors. */
  lastAttemptAt: number;
  /** Burn-rate estimate per window label, recomputed on each successful fetch. */
  pace: Map<string, PaceResult>;
}

const CRITICAL_HIT_MS = 60 * 60 * 1000;

function paceSeverity(state: ProviderState, now: Date): "safe" | "warn" | "critical" {
  let severity: "safe" | "warn" | "critical" = "safe";
  for (const pace of state.pace.values()) {
    if (!pace.willHitBeforeReset || !pace.projectedHitAt) {
      continue;
    }
    if (pace.projectedHitAt.getTime() - now.getTime() <= CRITICAL_HIT_MS) {
      return "critical";
    }
    severity = "warn";
  }
  return severity;
}

function formatCountdown(resetsAt: Date, now: Date): string {
  const ms = resetsAt.getTime() - now.getTime();
  if (ms <= 0) {
    return vscode.l10n.t("now");
  }
  const totalMinutes = Math.round(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return vscode.l10n.t("{0}d {1}h", days, hours);
  }
  if (hours > 0) {
    return vscode.l10n.t("{0}h {1}m", hours, minutes);
  }
  return vscode.l10n.t("{0}m", minutes);
}

/** "5h" → "5時間", "7d Opus" → "7日 Opus" when the display language localizes the units. */
function localizeWindowLabel(label: string): string {
  return label.replace(/^(\d+)([hd])/, (_match, n: string, unit: string) =>
    unit === "h" ? vscode.l10n.t("{0}h", n) : vscode.l10n.t("{0}d", n),
  );
}

function statusText(state: ProviderState): string {
  const { provider, snapshot, lastError } = state;
  if (!snapshot) {
    return lastError ? `$(warning) ${provider.shortName} —` : `$(sync~spin) ${provider.shortName}`;
  }
  // Keep the bar compact: show at most the first two windows (session + weekly).
  // On fetch errors, keep the last known data visible and just append a warning icon.
  // "↗" marks windows on pace to hit their limit before the reset.
  const format = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>("displayFormat", "percent");
  const parts = snapshot.windows
    .slice(0, 2)
    .map((w) => {
      const onPaceToHit = state.pace.get(w.label)?.willHitBeforeReset ? "↗" : "";
      const pct = `${Math.round(w.usedPercent)}%`;
      const bar = renderBar(w.usedPercent, 5);
      const value = format === "bar" ? bar : format === "both" ? `${bar} ${pct}` : pct;
      return `${localizeWindowLabel(w.label)} ${value}${onPaceToHit}`;
    });
  const suffix = lastError ? " $(warning)" : "";
  return `${provider.shortName} ${parts.join(" · ")}${suffix}`;
}

function errorSummary(error: Error, providerName: string): string {
  if (error instanceof ProviderError) {
    switch (error.kind) {
      case "not-logged-in":
        return vscode.l10n.t(
          "Not signed in or the token has expired. Run the {0} CLI once to sign in again.",
          providerName,
        );
      case "rate-limited":
        return vscode.l10n.t(
          "The {0} usage API is rate limited right now. Retrying later automatically.",
          providerName,
        );
      case "http":
        return vscode.l10n.t("Failed to fetch usage data from the {0} API.", providerName);
      case "parse":
        return vscode.l10n.t("Failed to parse the {0} usage API response.", providerName);
    }
  }
  return error.message;
}

function buildTooltip(state: ProviderState): vscode.MarkdownString {
  const { provider, snapshot, lastError } = state;
  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;
  md.appendMarkdown(`**${vscode.l10n.t("{0} usage", provider.displayName)}**\n\n`);
  if (lastError) {
    md.appendMarkdown(`$(warning) ${errorSummary(lastError, provider.displayName)}\n\n`);
  }
  if (snapshot) {
    const now = new Date();
    // Bar gauges like Claude Code's /usage view; the suffix is the reset countdown.
    const labels = snapshot.windows.map((w) => localizeWindowLabel(w.label));
    const labelWidth = Math.max(...labels.map(displayWidth)) + 2;
    const lines = snapshot.windows.map((w, i) => {
      const reset = w.resetsAt ? formatCountdown(w.resetsAt, now) : "";
      const risk = state.pace.get(w.label)?.willHitBeforeReset ? " ↗" : "";
      return renderGaugeLine(labels[i], w.usedPercent, `${reset}${risk}`, labelWidth);
    });
    md.appendCodeblock(lines.join("\n"), "text");
    md.appendMarkdown(`\n`);
    const atRisk = snapshot.windows.filter((w) => state.pace.get(w.label)?.willHitBeforeReset);
    if (atRisk.length > 0) {
      for (const w of atRisk) {
        const pace = state.pace.get(w.label)!;
        // Long windows are judged and reported per day, short ones per hour.
        const perDay = (w.windowSeconds ?? 0) >= 2 * 86400;
        const rateText = perDay
          ? vscode.l10n.t("{0}%/day", (pace.ratePerHour * 24).toFixed(1))
          : vscode.l10n.t("{0}%/h", pace.ratePerHour.toFixed(1));
        md.appendMarkdown(
          `$(flame) ${vscode.l10n.t(
            "{0} window: at the current pace ({1}), the limit will be reached in about {2} — before the reset.",
            localizeWindowLabel(w.label),
            rateText,
            formatCountdown(pace.projectedHitAt!, now),
          )}\n\n`,
        );
      }
    } else if (state.pace.size > 0) {
      md.appendMarkdown(`${vscode.l10n.t("At the current pace, no limit is reached before its reset.")}\n\n`);
    }
    const credits = snapshot.credits;
    if (credits) {
      if (credits.unlimited) {
        md.appendMarkdown(`${vscode.l10n.t("Credits: unlimited")}\n\n`);
      } else if (typeof credits.usedMinor === "number" && typeof credits.limitMinor === "number") {
        const exp = credits.exponent ?? 2;
        const symbol = credits.currency === "USD" ? "$" : credits.currency ? `${credits.currency} ` : "";
        const fmt = (minor: number) => `${symbol}${(minor / 10 ** exp).toFixed(exp)}`;
        const pct = credits.limitMinor > 0 ? ((credits.usedMinor / credits.limitMinor) * 100).toFixed(1) : "0";
        md.appendMarkdown(
          `${vscode.l10n.t(
            "Extra usage credits: {0} used / {1} ({2}%), {3} left",
            fmt(credits.usedMinor),
            fmt(credits.limitMinor),
            pct,
            fmt(Math.max(0, credits.limitMinor - credits.usedMinor)),
          )}\n\n`,
        );
      } else if (credits.balance !== undefined) {
        md.appendMarkdown(`${vscode.l10n.t("Credit balance: {0}", credits.balance)}\n\n`);
      }
    }
    if (snapshot.plan) {
      md.appendMarkdown(`${vscode.l10n.t("Plan: {0}", snapshot.plan)}\n\n`);
    }
    if (provider.id === "claude") {
      appendSessionCost(md);
    }
    md.appendMarkdown(`_${vscode.l10n.t("Updated {0}", snapshot.fetchedAt.toLocaleTimeString())}_\n\n`);
  }
  md.appendMarkdown(vscode.l10n.t("Click to refresh."));
  return md;
}

function applyColor(state: ProviderState): void {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const warn = config.get<number>("warnThresholdPercent", 80);
  const error = config.get<number>("errorThresholdPercent", 95);
  const max = state.snapshot
    ? Math.max(...state.snapshot.windows.map((w) => w.usedPercent))
    : 0;

  // Rate limiting is a normal condition, not a failure — never paint it as an error.
  // Other errors only force the error color when we have no data at all to show.
  const isRateLimited = state.lastError instanceof ProviderError && state.lastError.kind === "rate-limited";
  const hardError = state.lastError !== undefined && !isRateLimited && !state.snapshot;
  const severity = paceSeverity(state, new Date());

  if (hardError || max >= error || severity === "critical") {
    state.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  } else if (max >= warn || severity === "warn") {
    state.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else {
    state.item.backgroundColor = undefined;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const providers: UsageProvider[] = [new ClaudeProvider(), new CodexProvider()];
  const states = new Map<string, ProviderState>();
  // Shared across every window of this profile — the cross-window cache lives here.
  const cacheDir = context.globalStorageUri.fsPath;
  let timer: NodeJS.Timeout | undefined;

  function effectiveIntervalMs(state: ProviderState): number {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const base = Math.max(60, config.get<number>("pollIntervalSeconds", 300));
    return Math.max(base, state.provider.minPollIntervalSeconds ?? 0) * 1000;
  }

  function adoptSnapshot(state: ProviderState, snapshot: UsageSnapshot): void {
    const isNew = !state.snapshot || snapshot.fetchedAt.getTime() !== state.snapshot.fetchedAt.getTime();
    state.snapshot = snapshot;
    state.lastError = undefined;
    state.consecutiveFailures = 0;
    state.skipTicks = 0;
    if (isNew) {
      updatePace(state, snapshot);
    }
  }

  let priority = 100;
  for (const provider of providers) {
    const item = vscode.window.createStatusBarItem(
      `llmUsageBar.${provider.id}`,
      vscode.StatusBarAlignment.Right,
      priority--,
    );
    item.name = `LLM Usage: ${provider.displayName}`;
    item.command = "llmUsageBar.refresh";
    context.subscriptions.push(item);
    states.set(provider.id, {
      provider,
      item,
      consecutiveFailures: 0,
      skipTicks: 0,
      lastAttemptAt: 0,
      pace: new Map(),
    });
  }

  function historyKey(providerId: string, windowLabel: string): string {
    return `history.${providerId}.${windowLabel}`;
  }

  function updatePace(state: ProviderState, snapshot: UsageSnapshot): void {
    const now = snapshot.fetchedAt;
    state.pace = new Map();
    for (const w of snapshot.windows) {
      const key = historyKey(state.provider.id, w.label);
      const history = appendSample(context.globalState.get<Sample[]>(key, []), {
        t: now.getTime(),
        p: w.usedPercent,
      });
      void context.globalState.update(key, history);
      const pace = computePace(history, w.resetsAt, now, w.windowSeconds);
      if (pace) {
        state.pace.set(w.label, pace);
      }
    }
  }

  function render(state: ProviderState): void {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const enabled = config.get<boolean>(`${state.provider.id}.enabled`, true);
    if (!enabled) {
      state.item.hide();
      return;
    }
    state.item.text = statusText(state);
    state.item.tooltip = buildTooltip(state);
    applyColor(state);
    state.item.show();
  }

  async function refreshOne(state: ProviderState, force = false): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    if (!config.get<boolean>(`${state.provider.id}.enabled`, true)) {
      render(state);
      return;
    }
    state.lastAttemptAt = Date.now();
    const id = state.provider.id;

    // Serve from the cross-window cache when another window fetched recently,
    // so N open windows produce one API call per interval instead of N.
    const cached = readSharedCache(cacheDir, id);
    if (cached && !force && Date.now() - cached.fetchedAt.getTime() < effectiveIntervalMs(state)) {
      adoptSnapshot(state, cached);
      render(state);
      return;
    }

    // A recent failure in ANY window pauses fetching in ALL windows; otherwise
    // each window retries independently and a rate-limited API never recovers.
    const cooldownUntil = readCooldownUntil(cacheDir, id);
    if (!force && Date.now() < cooldownUntil) {
      if (cached) {
        adoptSnapshot(state, cached);
      }
      state.lastError = new ProviderError(
        `${state.provider.displayName} usage API is cooling down after a failure.`,
        "rate-limited",
      );
      render(state);
      return;
    }

    if (!tryAcquireFetchLock(cacheDir, id)) {
      // Another window is fetching right now; show what we have and wait for its result.
      if (cached) {
        adoptSnapshot(state, cached);
      }
      render(state);
      return;
    }
    try {
      const snapshot = await state.provider.fetchUsage();
      writeSharedCache(cacheDir, id, snapshot);
      adoptSnapshot(state, snapshot);
    } catch (err) {
      state.lastError = err instanceof Error ? err : new Error(String(err));
      state.consecutiveFailures++;
      state.skipTicks = Math.min(2 ** state.consecutiveFailures, 16);
      const isRateLimited = err instanceof ProviderError && err.kind === "rate-limited";
      writeCooldown(cacheDir, id, Date.now() + (isRateLimited ? 15 : 5) * 60 * 1000);
    } finally {
      releaseFetchLock(cacheDir, id);
    }
    render(state);
  }

  async function refreshAll(force = false): Promise<void> {
    await Promise.all([...states.values()].map((s) => refreshOne(s, force)));
  }

  function schedule(): void {
    if (timer) {
      clearInterval(timer);
    }
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const base = Math.max(60, config.get<number>("pollIntervalSeconds", 300));
    timer = setInterval(() => {
      for (const state of states.values()) {
        if (state.skipTicks > 0) {
          state.skipTicks--;
          continue;
        }
        // Providers with strict API rate limits enforce a longer effective interval.
        if (Date.now() - state.lastAttemptAt < effectiveIntervalMs(state) - 1000) {
          continue;
        }
        void refreshOne(state);
      }
    }, base * 1000);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("llmUsageBar.refresh", () => {
      for (const state of states.values()) {
        state.consecutiveFailures = 0;
        state.skipTicks = 0;
        state.lastAttemptAt = 0;
      }
      void refreshAll(true);
    }),
    vscode.commands.registerCommand("llmUsageBar.checkForUpdates", async () => {
      const installed = String(context.extension.packageJSON.version ?? "");
      try {
        await installLatestRelease(installed);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(vscode.l10n.t("LLM Usage Bar: update failed. {0}", message));
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG_SECTION)) {
        schedule();
        void refreshAll();
      }
    }),
    new vscode.Disposable(() => {
      if (timer) {
        clearInterval(timer);
      }
    }),
  );

  for (const state of states.values()) {
    render(state);
  }
  void refreshAll();
  schedule();
  void checkForUpdatesInBackground(context);
}

export function deactivate(): void {
  // Disposables are cleaned up via context.subscriptions.
}
