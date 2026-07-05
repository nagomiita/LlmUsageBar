import * as fs from "fs";
import * as path from "path";
import type { UsageSnapshot } from "./types";

/**
 * File-based snapshot cache shared by every VS Code window running this
 * extension. Each open window has its own extension host, so without this
 * N windows would multiply the polling rate N-fold — which is what exhausted
 * the Claude usage API's strict rate limit. With it, one window fetches per
 * interval and the rest read the cached result.
 */

interface SerializedWindow {
  label: string;
  usedPercent: number;
  resetsAt?: string;
  windowSeconds?: number;
}

interface SerializedSnapshot {
  windows: SerializedWindow[];
  plan?: string;
  fetchedAt: string;
}

const LOCK_STALE_MS = 2 * 60 * 1000;

function cachePath(dir: string, providerId: string): string {
  return path.join(dir, `usage-${providerId}.json`);
}

function lockPath(dir: string, providerId: string): string {
  return path.join(dir, `fetch-${providerId}.lock`);
}

export function readSharedCache(dir: string, providerId: string): UsageSnapshot | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(dir, providerId), "utf8")) as SerializedSnapshot;
    if (!Array.isArray(raw.windows) || typeof raw.fetchedAt !== "string") {
      return undefined;
    }
    return {
      windows: raw.windows.map((w) => ({
        label: w.label,
        usedPercent: w.usedPercent,
        resetsAt: w.resetsAt ? new Date(w.resetsAt) : undefined,
        windowSeconds: w.windowSeconds,
      })),
      plan: raw.plan,
      fetchedAt: new Date(raw.fetchedAt),
    };
  } catch {
    return undefined;
  }
}

export function writeSharedCache(dir: string, providerId: string, snapshot: UsageSnapshot): void {
  const serialized: SerializedSnapshot = {
    windows: snapshot.windows.map((w) => ({
      label: w.label,
      usedPercent: w.usedPercent,
      resetsAt: w.resetsAt?.toISOString(),
      windowSeconds: w.windowSeconds,
    })),
    plan: snapshot.plan,
    fetchedAt: snapshot.fetchedAt.toISOString(),
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = cachePath(dir, providerId) + `.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(serialized));
    fs.renameSync(tmp, cachePath(dir, providerId));
  } catch {
    // Cache is best-effort; never let it break the fetch itself.
  }
}

/** Returns true when this window may fetch; false when another window holds the lock. */
export function tryAcquireFetchLock(dir: string, providerId: string, now = Date.now()): boolean {
  const file = lockPath(dir, providerId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    try {
      const age = now - fs.statSync(file).mtimeMs;
      if (age > LOCK_STALE_MS) {
        // The holder likely died (window closed mid-fetch); take the lock over.
        fs.writeFileSync(file, String(process.pid));
        return true;
      }
    } catch {
      // Lock vanished between the two calls — treat as contended this round.
    }
    return false;
  }
}

export function releaseFetchLock(dir: string, providerId: string): void {
  try {
    fs.unlinkSync(lockPath(dir, providerId));
  } catch {
    // Already gone; nothing to release.
  }
}
