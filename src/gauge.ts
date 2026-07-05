/** Text progress bars for status bar / tooltip, like Claude Code's /usage view. */

export function renderBar(percent: number, width: number): string {
  const clamped = Math.min(100, Math.max(0, percent));
  const filled = Math.round((clamped / 100) * width);
  // ▰/▱ are a matched pair that does not fill the whole line box, so bars on
  // adjacent lines keep a visible gap (full-height glyphs like █/▓ touch).
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

/** Terminal-column width: CJK characters occupy two columns. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    width += (cp >= 0x1100 && cp <= 0x9fff) || (cp >= 0xff00 && cp <= 0xffef) ? 2 : 1;
  }
  return width;
}

/** One aligned tooltip line: `5h  ▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱  39%` (+ suffix). */
export function renderGaugeLine(label: string, percent: number, suffix: string, labelWidth: number): string {
  const pct = `${String(Math.round(Math.min(100, Math.max(0, percent)))).padStart(3)}%`;
  const pad = " ".repeat(Math.max(0, labelWidth - displayWidth(label)));
  return `${label}${pad} ${renderBar(percent, 20)} ${pct}${suffix ? `  ${suffix}` : ""}`;
}
