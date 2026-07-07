import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { estimateSessionCost, parseSessionUsage, priceFor } from "../cost";

function assistant(model: string, usage: Record<string, unknown>, id = "msg_1") {
  return JSON.stringify({ type: "assistant", message: { id, model, usage } });
}

test("priceFor matches model families and falls through", () => {
  assert.deepEqual(priceFor("claude-fable-5"), { input: 10, output: 50 });
  assert.deepEqual(priceFor("claude-opus-4-8"), { input: 5, output: 25 });
  assert.deepEqual(priceFor("claude-opus-4-1"), { input: 15, output: 75 });
  assert.deepEqual(priceFor("claude-sonnet-5"), { input: 3, output: 15 });
  assert.deepEqual(priceFor("claude-haiku-4-5"), { input: 1, output: 5 });
  assert.equal(priceFor("some-unknown-model"), undefined);
  assert.equal(priceFor(undefined), undefined);
});

test("costs input, output, cache read and cache write at their multipliers", () => {
  // Opus 4.8: input $5, output $25 per 1M.
  const line = assistant("claude-opus-4-8", {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000, // 0.1x input = $0.50
    cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
  });
  const r = parseSessionUsage([line]);
  // 5 + 25 + 0.5 + (5*1.25) + (5*2.0) = 5 + 25 + 0.5 + 6.25 + 10 = 46.75
  assert.equal(Number(r.costUsd.toFixed(2)), 46.75);
  assert.equal(r.model, "claude-opus-4-8");
  assert.equal(r.messageCount, 1);
  assert.equal(r.hasUnpricedModel, false);
});

test("falls back to 5m rate when cache_creation breakdown is absent", () => {
  const line = assistant("claude-opus-4-8", {
    cache_creation_input_tokens: 1_000_000, // 5*1.25 = 6.25
  });
  const r = parseSessionUsage([line]);
  assert.equal(Number(r.costUsd.toFixed(2)), 6.25);
});

test("dedupes cost by message.id but tracks latest context", () => {
  const dup = assistant(
    "claude-opus-4-8",
    { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 },
    "msg_same",
  );
  const later = assistant(
    "claude-opus-4-8",
    { input_tokens: 20, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200 },
    "msg_new",
  );
  const r = parseSessionUsage([dup, dup, dup, later]);
  assert.equal(r.messageCount, 2); // two unique ids, not four lines
  assert.equal(r.contextTokens, 5220); // last line: 20 + 5000 + 200
  assert.equal(r.model, "claude-opus-4-8");
});

test("ignores non-assistant lines, blanks, and malformed JSON", () => {
  const r = parseSessionUsage([
    "",
    "{ not json",
    JSON.stringify({ type: "user", message: { content: "hi" } }),
    JSON.stringify({ type: "assistant", message: { id: "x", model: "claude-opus-4-8" } }), // no usage
    assistant("claude-opus-4-8", { output_tokens: 1_000_000 }, "real"),
  ]);
  assert.equal(r.messageCount, 1);
  assert.equal(Number(r.costUsd.toFixed(2)), 25);
});

test("flags unpriced models but still counts context", () => {
  const line = assistant("mystery-model-9", { input_tokens: 5, cache_read_input_tokens: 100 });
  const r = parseSessionUsage([line]);
  assert.equal(r.hasUnpricedModel, true);
  assert.equal(r.costUsd, 0);
  assert.equal(r.contextTokens, 105);
});

test("estimateSessionCost reads the newest transcript for a workspace", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lub-cost-"));
  try {
    const projectsDir = path.join(tmp, "projects");
    const workspace = "/home/user/proj.test";
    const dir = path.join(projectsDir, workspace.replace(/[^a-zA-Z0-9]/g, "-"));
    fs.mkdirSync(dir, { recursive: true });

    const older = path.join(dir, "old.jsonl");
    fs.writeFileSync(older, assistant("claude-opus-4-8", { output_tokens: 1_000_000 }, "old"));
    const newer = path.join(dir, "new.jsonl");
    fs.writeFileSync(newer, assistant("claude-opus-4-8", { output_tokens: 2_000_000 }, "new"));
    // Ensure the second file is newer regardless of filesystem timestamp resolution.
    const now = Date.now();
    fs.utimesSync(older, new Date(now - 10_000), new Date(now - 10_000));
    fs.utimesSync(newer, new Date(now), new Date(now));

    const r = estimateSessionCost(workspace, { projectsDir });
    assert.ok(r);
    assert.equal(Number(r.costUsd.toFixed(2)), 50); // newest file: 2M output * $25
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("estimateSessionCost returns undefined when no session dir exists", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lub-cost-"));
  try {
    assert.equal(estimateSessionCost("/no/such/place", { projectsDir: tmp }), undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
