import { test } from "node:test";
import * as assert from "node:assert/strict";
import { displayWidth, renderBar, renderGaugeLine } from "../gauge";

test("renderBar fills proportionally and clamps", () => {
  assert.equal(renderBar(0, 10), "▱▱▱▱▱▱▱▱▱▱");
  assert.equal(renderBar(50, 10), "▰▰▰▰▰▱▱▱▱▱");
  assert.equal(renderBar(100, 10), "▰▰▰▰▰▰▰▰▰▰");
  assert.equal(renderBar(-5, 10), "▱▱▱▱▱▱▱▱▱▱");
  assert.equal(renderBar(150, 10), "▰▰▰▰▰▰▰▰▰▰");
  assert.equal(renderBar(30, 20), "▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱");
});

test("CJK labels pad by display width so bars stay aligned", () => {
  assert.equal(displayWidth("5h"), 2);
  assert.equal(displayWidth("5時間"), 5);
  assert.equal(displayWidth("7日"), 3);
  // "5時間" (5 cols) and "7日" (3 cols) both padded to 7 columns → bars start at the same column.
  const a = renderGaugeLine("5時間", 50, "", 7);
  const b = renderGaugeLine("7日", 50, "", 7);
  assert.equal(a.indexOf("▰"), "5時間".length + 2 + 1);
  assert.equal(b.indexOf("▰"), "7日".length + 4 + 1);
});

test("renderGaugeLine aligns label and percent", () => {
  const line = renderGaugeLine("5h", 39, "2h 13m", 8);
  assert.equal(line, "5h       ▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱  39%  2h 13m");
  const noSuffix = renderGaugeLine("7d Opus", 100, "", 8);
  assert.equal(noSuffix, "7d Opus  ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰ 100%");
});
