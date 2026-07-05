import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  readSharedCache,
  releaseFetchLock,
  tryAcquireFetchLock,
  writeSharedCache,
} from "../sharedCache";
import type { UsageSnapshot } from "../types";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "llm-usage-bar-test-"));
}

const SNAPSHOT: UsageSnapshot = {
  windows: [
    { label: "5h", usedPercent: 39, resetsAt: new Date("2026-07-05T10:00:00Z"), windowSeconds: 18000 },
    { label: "7d", usedPercent: 52, windowSeconds: 604800 },
  ],
  plan: "plus",
  fetchedAt: new Date("2026-07-05T08:00:00Z"),
};

test("cache round-trips snapshots with dates revived", () => {
  const dir = tmpDir();
  writeSharedCache(dir, "claude", SNAPSHOT);
  const read = readSharedCache(dir, "claude");
  assert.ok(read);
  assert.equal(read.fetchedAt.getTime(), SNAPSHOT.fetchedAt.getTime());
  assert.equal(read.windows[0].resetsAt?.getTime(), SNAPSHOT.windows[0].resetsAt?.getTime());
  assert.equal(read.windows[1].resetsAt, undefined);
  assert.equal(read.plan, "plus");
  assert.equal(read.windows[1].windowSeconds, 604800);
});

test("readSharedCache returns undefined for missing or corrupt files", () => {
  const dir = tmpDir();
  assert.equal(readSharedCache(dir, "claude"), undefined);
  fs.writeFileSync(path.join(dir, "usage-claude.json"), "not json");
  assert.equal(readSharedCache(dir, "claude"), undefined);
});

test("second acquirer is rejected until the lock is released", () => {
  const dir = tmpDir();
  assert.equal(tryAcquireFetchLock(dir, "claude"), true);
  assert.equal(tryAcquireFetchLock(dir, "claude"), false);
  releaseFetchLock(dir, "claude");
  assert.equal(tryAcquireFetchLock(dir, "claude"), true);
});

test("a stale lock from a dead window is taken over", () => {
  const dir = tmpDir();
  assert.equal(tryAcquireFetchLock(dir, "claude"), true);
  const future = Date.now() + 3 * 60 * 1000;
  assert.equal(tryAcquireFetchLock(dir, "claude", future), true);
});
