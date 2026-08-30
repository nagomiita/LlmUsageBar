import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildShellInvocation,
  defaultGreetingCommand,
  dueAnchors,
  hasActiveSessionWindow,
  nextAnchor,
} from "../anchor";
import { cleanupOnceMarkers, tryAcquireOnceMarker } from "../sharedCache";
import type { UsageSnapshot } from "../types";

// 2026-08-31 is a Monday, 2026-08-30 a Sunday (local-time constructors below).
function local(y: number, mo: number, d: number, hh: number, mm: number): Date {
  return new Date(y, mo - 1, d, hh, mm, 0, 0);
}

test("dueAnchors fires within the grace window on a weekday", () => {
  const due = dueAnchors(["07:00"], local(2026, 8, 31, 7, 10), 30, true);
  assert.equal(due.length, 1);
  assert.equal(due[0].key, "2026-08-31-0700");
  assert.equal(due[0].time, "07:00");
});

test("dueAnchors is not due before the time or after the grace window", () => {
  assert.equal(dueAnchors(["07:00"], local(2026, 8, 31, 6, 59), 30, true).length, 0);
  assert.equal(dueAnchors(["07:00"], local(2026, 8, 31, 7, 30), 30, true).length, 0);
});

test("dueAnchors skips weekends unless weekdaysOnly is off", () => {
  const sunday = local(2026, 8, 30, 7, 10);
  assert.equal(dueAnchors(["07:00"], sunday, 30, true).length, 0);
  assert.equal(dueAnchors(["07:00"], sunday, 30, false).length, 1);
});

test("dueAnchors ignores invalid time strings and accepts single-digit hours", () => {
  assert.equal(dueAnchors(["7am", "25:00", "12:60", ""], local(2026, 8, 31, 12, 0), 30, true).length, 0);
  const due = dueAnchors(["7:00"], local(2026, 8, 31, 7, 0), 30, true);
  assert.equal(due.length, 1);
  assert.equal(due[0].time, "07:00");
});

test("dueAnchors keeps yesterday's anchor due when grace crosses midnight", () => {
  // Monday 23:50 anchor, checked Tuesday 00:10 with a 30-minute grace.
  const due = dueAnchors(["23:50"], local(2026, 9, 1, 0, 10), 30, true);
  assert.equal(due.length, 1);
  assert.equal(due[0].key, "2026-08-31-2350");
});

test("dueAnchors deduplicates equivalent times", () => {
  const due = dueAnchors(["07:00", "07:00", "7:00"], local(2026, 8, 31, 7, 5), 30, true);
  assert.equal(due.length, 1);
});

test("nextAnchor picks the next occurrence today", () => {
  const next = nextAnchor(["07:00", "12:00", "17:00"], local(2026, 8, 31, 8, 0), true);
  assert.deepEqual(next, local(2026, 8, 31, 12, 0));
});

test("nextAnchor lands exactly on an anchor time", () => {
  const next = nextAnchor(["12:00"], local(2026, 8, 31, 12, 0), true);
  assert.deepEqual(next, local(2026, 8, 31, 12, 0));
});

test("nextAnchor skips the weekend when weekdaysOnly", () => {
  // Friday 18:00 → all of Friday's anchors have passed; Monday 07:00 is next.
  const friday = local(2026, 8, 28, 18, 0);
  assert.deepEqual(nextAnchor(["07:00", "12:00", "17:00"], friday, true), local(2026, 8, 31, 7, 0));
  assert.deepEqual(nextAnchor(["07:00", "12:00", "17:00"], friday, false), local(2026, 8, 29, 7, 0));
});

test("nextAnchor returns undefined for invalid times", () => {
  assert.equal(nextAnchor(["7am", ""], local(2026, 8, 31, 8, 0), true), undefined);
});

function snapshot(usedPercent: number, resetsAt?: Date): UsageSnapshot {
  return {
    windows: [{ label: "5h", usedPercent, resetsAt, windowSeconds: 5 * 3600 }],
    fetchedAt: new Date(),
  };
}

test("hasActiveSessionWindow requires usage and a future reset", () => {
  const now = local(2026, 8, 31, 8, 0);
  const future = local(2026, 8, 31, 12, 0);
  const past = local(2026, 8, 31, 7, 0);
  assert.equal(hasActiveSessionWindow(undefined, now), false);
  assert.equal(hasActiveSessionWindow(snapshot(0, future), now), false);
  assert.equal(hasActiveSessionWindow(snapshot(5, future), now), true);
  assert.equal(hasActiveSessionWindow(snapshot(5, past), now), false);
  assert.equal(hasActiveSessionWindow(snapshot(5, undefined), now), false);
});

test("defaultGreetingCommand covers claude and codex only", () => {
  assert.match(defaultGreetingCommand("claude") ?? "", /^claude /);
  assert.match(defaultGreetingCommand("codex") ?? "", /^codex exec /);
  assert.equal(defaultGreetingCommand("github"), undefined);
});

test("buildShellInvocation uses a login shell on POSIX and cmd on Windows", () => {
  assert.deepEqual(buildShellInvocation("claude -p hi", "darwin", "/bin/zsh"), {
    file: "/bin/zsh",
    args: ["-lc", "claude -p hi"],
  });
  // "" = SHELL not set (explicit undefined would fall back to this process's env).
  assert.deepEqual(buildShellInvocation("claude -p hi", "linux", ""), {
    file: "/bin/sh",
    args: ["-lc", "claude -p hi"],
  });
  const win = buildShellInvocation("claude -p hi", "win32", "");
  assert.deepEqual(win.args, ["/d", "/s", "/c", "claude -p hi"]);
});

test("tryAcquireOnceMarker grants the first caller only, and cleanup frees old markers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-usage-bar-marker-"));
  try {
    assert.equal(tryAcquireOnceMarker(dir, "anchor-claude-2026-08-31-0700"), true);
    assert.equal(tryAcquireOnceMarker(dir, "anchor-claude-2026-08-31-0700"), false);
    assert.equal(tryAcquireOnceMarker(dir, "anchor-codex-2026-08-31-0700"), true);

    // Names are sanitized into safe file names.
    assert.equal(tryAcquireOnceMarker(dir, "weird/name with spaces"), true);
    assert.equal(tryAcquireOnceMarker(dir, "weird/name with spaces"), false);

    // Fresh markers survive cleanup; stale ones are removed and reacquirable.
    cleanupOnceMarkers(dir, "anchor-", 60_000);
    assert.equal(tryAcquireOnceMarker(dir, "anchor-claude-2026-08-31-0700"), false);
    cleanupOnceMarkers(dir, "anchor-", 60_000, Date.now() + 120_000);
    assert.equal(tryAcquireOnceMarker(dir, "anchor-claude-2026-08-31-0700"), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
