import { execFile } from "child_process";
import * as os from "os";
import type { UsageSnapshot } from "./types";

/**
 * Window anchoring ("greeting" scheduler): fire a tiny CLI prompt at fixed
 * local times so the provider's session rate-limit window (Claude 5h / Codex
 * primary) starts at predictable boundaries instead of whenever work happens
 * to begin. Times 5 hours apart (07:00 / 12:00 / 17:00) keep the boundaries
 * aligned across the whole workday.
 */

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export interface DueAnchor {
  /** Stable id of this occurrence, e.g. "2026-08-30-0700" (local date). */
  key: string;
  /** The configured time, normalized to "HH:MM". */
  time: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Anchor occurrences whose grace window contains `now`. VS Code may have been
 * closed or asleep at the exact anchor time, so each anchor stays "due" for
 * `graceMinutes` after it; beyond that we wait for the next one rather than
 * start a window at a misaligned time. Invalid time strings are ignored.
 */
export function dueAnchors(
  times: string[],
  now: Date,
  graceMinutes: number,
  weekdaysOnly: boolean,
): DueAnchor[] {
  const graceMs = Math.max(1, graceMinutes) * 60_000;
  const result: DueAnchor[] = [];
  const seen = new Set<string>();
  for (const raw of times) {
    const match = TIME_RE.exec(raw.trim());
    if (!match) {
      continue;
    }
    const hh = Number(match[1]);
    const mm = Number(match[2]);
    // The due occurrence is usually today's, but a grace window crossing
    // midnight can keep yesterday's late anchor due as well.
    for (const dayOffset of [0, -1]) {
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hh, mm, 0, 0);
      if (now.getTime() < at.getTime() || now.getTime() >= at.getTime() + graceMs) {
        continue;
      }
      if (weekdaysOnly && (at.getDay() === 0 || at.getDay() === 6)) {
        continue;
      }
      const key = `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}-${pad2(hh)}${pad2(mm)}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ key, time: `${pad2(hh)}:${pad2(mm)}` });
      }
    }
  }
  return result;
}

/** The earliest anchor occurrence at or after `now`; undefined when no time qualifies. */
export function nextAnchor(times: string[], now: Date, weekdaysOnly: boolean): Date | undefined {
  let best: Date | undefined;
  for (const raw of times) {
    const match = TIME_RE.exec(raw.trim());
    if (!match) {
      continue;
    }
    const hh = Number(match[1]);
    const mm = Number(match[2]);
    for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hh, mm, 0, 0);
      if (at.getTime() < now.getTime() || (weekdaysOnly && (at.getDay() === 0 || at.getDay() === 6))) {
        continue;
      }
      if (!best || at.getTime() < best.getTime()) {
        best = at;
      }
      break;
    }
  }
  return best;
}

/**
 * Whether the session window (5h for Claude, primary for Codex — always the
 * first window, since snapshots order shortest-first) is already running.
 * Requires usedPercent > 0: a rolling resets_at alone doesn't prove a window
 * started, and a duplicate greeting inside an active window is harmless while
 * a skipped one defeats the feature.
 */
export function hasActiveSessionWindow(snapshot: UsageSnapshot | undefined, now: Date): boolean {
  const w = snapshot?.windows[0];
  if (!w || !w.resetsAt) {
    return false;
  }
  return w.usedPercent > 0 && w.resetsAt.getTime() > now.getTime();
}

/**
 * The cheapest official way to start a window: one non-interactive CLI turn.
 * Claude pins the smallest model; Codex runs read-only outside a git repo
 * (cwd is the home directory).
 */
export function defaultGreetingCommand(providerId: string): string | undefined {
  switch (providerId) {
    case "claude":
      return "claude --model haiku -p 'Reply with only: ok'";
    case "codex":
      return "codex exec --skip-git-repo-check --sandbox read-only 'Reply with only: ok'";
    default:
      return undefined;
  }
}

export interface ShellInvocation {
  file: string;
  args: string[];
}

/**
 * Run through the user's login shell on macOS/Linux so the CLIs resolve via
 * the same PATH as a terminal (GUI-launched VS Code often lacks nvm/homebrew
 * paths); plain cmd.exe on Windows.
 */
export function buildShellInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
  shellEnv: string | undefined = process.env.SHELL,
): ShellInvocation {
  if (platform === "win32") {
    return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  const shell = shellEnv && shellEnv.length > 0 ? shellEnv : "/bin/sh";
  return { file: shell, args: ["-lc", command] };
}

export interface GreetingResult {
  ok: boolean;
  detail: string;
}

export function runGreeting(command: string, timeoutMs = 180_000): Promise<GreetingResult> {
  const { file, args } = buildShellInvocation(command);
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, cwd: os.homedir(), maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, detail: (stderr.trim() || error.message).slice(0, 400) });
        } else {
          resolve({ ok: true, detail: stdout.trim().slice(0, 200) });
        }
      },
    );
  });
}
