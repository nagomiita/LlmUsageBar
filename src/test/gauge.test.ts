import { test } from "node:test";
import * as assert from "node:assert/strict";
import { renderBar, renderGaugeLine } from "../gauge";

test("renderBar fills proportionally and clamps", () => {
  assert.equal(renderBar(0, 10), "░░░░░░░░░░");
  assert.equal(renderBar(50, 10), "█████░░░░░");
  assert.equal(renderBar(100, 10), "██████████");
  assert.equal(renderBar(-5, 10), "░░░░░░░░░░");
  assert.equal(renderBar(150, 10), "██████████");
  assert.equal(renderBar(30, 20), "██████░░░░░░░░░░░░░░");
});

test("renderGaugeLine aligns label and percent", () => {
  const line = renderGaugeLine("5h", 39, "2h 13m", 8);
  assert.equal(line, "5h       ████████░░░░░░░░░░░░  39%  2h 13m");
  const noSuffix = renderGaugeLine("7d Opus", 100, "", 8);
  assert.equal(noSuffix, "7d Opus  ████████████████████ 100%");
});
