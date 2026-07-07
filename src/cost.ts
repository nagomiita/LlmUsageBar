import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Per-million-token USD rates for a model's input and output. */
export interface Price {
  input: number;
  output: number;
}

/** Matched top-to-bottom; first hit wins. Rates are USD per 1M tokens (2026-06). */
const PRICE_RULES: Array<{ match: RegExp; price: Price }> = [
  { match: /fable-5|mythos-5/, price: { input: 10, output: 50 } },
  { match: /opus-4-(8|7|6|5)/, price: { input: 5, output: 25 } },
  { match: /opus/, price: { input: 15, output: 75 } }, // opus 4.1 / 4.0 / 3
  { match: /sonnet/, price: { input: 3, output: 15 } },
  { match: /haiku/, price: { input: 1, output: 5 } },
];

// Cache tokens are billed relative to the model's input rate.
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2.0;

/** Resolve a model id to its price, or undefined if unrecognized. */
export function priceFor(model: string | undefined): Price | undefined {
  if (!model) {
    return undefined;
  }
  for (const { match, price } of PRICE_RULES) {
    if (match.test(model)) {
      return price;
    }
  }
  return undefined;
}

interface CacheCreation {
  ephemeral_5m_input_tokens?: number;
  ephemeral_1h_input_tokens?: number;
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: CacheCreation;
}

interface AssistantLine {
  type?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: Usage;
  };
}

export interface SessionCost {
  /** Model of the most recent assistant message. */
  model?: string;
  /** Prompt size of the most recent turn: input + cache read + cache write. */
  contextTokens: number;
  /** Metered pay-as-you-go cost of the whole session so far, in USD. */
  costUsd: number;
  /** Number of billed API responses (unique assistant messages). */
  messageCount: number;
  /** True if any assistant message used a model with no known price. */
  hasUnpricedModel: boolean;
}

/** Total prompt size sent for a turn — what "current context" means. */
function contextOf(u: Usage): number {
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}

/** Metered USD cost of a single assistant response's usage. */
function costOf(u: Usage, price: Price): number {
  const perMillion = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;
  let cost = perMillion(u.input_tokens ?? 0, price.input);
  cost += perMillion(u.output_tokens ?? 0, price.output);
  cost += perMillion(u.cache_read_input_tokens ?? 0, price.input * CACHE_READ_MULT);

  // Prefer the 5m/1h breakdown; fall back to treating all writes as 5m.
  const creation = u.cache_creation;
  if (creation && (creation.ephemeral_5m_input_tokens != null || creation.ephemeral_1h_input_tokens != null)) {
    cost += perMillion(creation.ephemeral_5m_input_tokens ?? 0, price.input * CACHE_WRITE_5M_MULT);
    cost += perMillion(creation.ephemeral_1h_input_tokens ?? 0, price.input * CACHE_WRITE_1H_MULT);
  } else {
    cost += perMillion(u.cache_creation_input_tokens ?? 0, price.input * CACHE_WRITE_5M_MULT);
  }
  return cost;
}

/**
 * Aggregate metered cost and current context size from a session transcript's
 * JSONL lines. Streamed responses repeat one line per content block with an
 * identical `message.id` and usage, so cost is summed once per unique id.
 * Exported for tests.
 */
export function parseSessionUsage(lines: string[]): SessionCost {
  const seen = new Set<string>();
  let costUsd = 0;
  let messageCount = 0;
  let hasUnpricedModel = false;
  let lastContext = 0;
  let lastModel: string | undefined;

  for (const line of lines) {
    if (!line) {
      continue;
    }
    let obj: AssistantLine;
    try {
      obj = JSON.parse(line) as AssistantLine;
    } catch {
      continue;
    }
    const msg = obj.message;
    if (obj.type !== "assistant" || !msg?.usage) {
      continue;
    }
    // Last assistant line wins for "current context", even a duplicate one.
    lastContext = contextOf(msg.usage);
    lastModel = msg.model;

    const id = msg.id;
    if (id && seen.has(id)) {
      continue;
    }
    if (id) {
      seen.add(id);
    }
    messageCount++;
    const price = priceFor(msg.model);
    if (price) {
      costUsd += costOf(msg.usage, price);
    } else {
      hasUnpricedModel = true;
    }
  }

  return { model: lastModel, contextTokens: lastContext, costUsd, messageCount, hasUnpricedModel };
}

/** Claude Code's on-disk project dir name for a workspace path. */
function projectDirName(workspacePath: string): string {
  return workspacePath.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Newest `.jsonl` in a directory (the active session), or undefined. */
function newestSession(dir: string): string | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  let best: { file: string; mtime: number } | undefined;
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) {
      continue;
    }
    const full = path.join(dir, e.name);
    let mtime: number;
    try {
      mtime = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtime > best.mtime) {
      best = { file: full, mtime };
    }
  }
  return best?.file;
}

/**
 * Estimate the metered cost of the active Claude Code session for a workspace,
 * reading the newest transcript under ~/.claude/projects/<munged-path>/.
 * Returns undefined when no matching session file exists.
 */
export function estimateSessionCost(
  workspacePath: string,
  opts?: { projectsDir?: string },
): SessionCost | undefined {
  const projectsDir = opts?.projectsDir ?? path.join(os.homedir(), ".claude", "projects");
  const dir = path.join(projectsDir, projectDirName(workspacePath));
  const file = newestSession(dir);
  if (!file) {
    return undefined;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const result = parseSessionUsage(raw.split("\n"));
  return result.messageCount > 0 ? result : undefined;
}
