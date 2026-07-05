/** Text progress bars for status bar / tooltip, like Claude Code's /usage view. */

export function renderBar(percent: number, width: number): string {
  const clamped = Math.min(100, Math.max(0, percent));
  const filled = Math.round((clamped / 100) * width);
  // ▓/░ are both shade glyphs with identical metrics; mixing █ (FULL BLOCK)
  // with ░ renders at uneven heights in some fonts.
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

/** One aligned tooltip line: `5h  ████████░░░░░░░░░░░░  39%` (+ suffix). */
export function renderGaugeLine(label: string, percent: number, suffix: string, labelWidth: number): string {
  const pct = `${String(Math.round(Math.min(100, Math.max(0, percent)))).padStart(3)}%`;
  return `${label.padEnd(labelWidth)} ${renderBar(percent, 20)} ${pct}${suffix ? `  ${suffix}` : ""}`;
}
