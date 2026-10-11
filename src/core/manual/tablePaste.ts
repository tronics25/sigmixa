/**
 * Cells copied in a spreadsheet arrive as text: rows on lines, cells separated by tabs. A cell holding a line break or a
 * tab is wrapped in double quotes, with a quote inside written twice.
 */
export function parseCopiedCells(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false; let index = 0;
  const source = text.replace(/\r\n?/g, '\n');
  while (index < source.length) {
    const character = source[index];
    if (quoted) {
      if (character === '"') { if (source[index + 1] === '"') { cell += '"'; index += 2; continue; } quoted = false; index++; continue; }
      cell += character; index++; continue;
    }
    if (character === '"' && cell === '') { quoted = true; index++; continue; }
    if (character === '\t') { row.push(cell); cell = ''; index++; continue; }
    if (character === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; index++; continue; }
    cell += character; index++;
  }
  // A spreadsheet ends the last row with a line break; that is not one more, empty row.
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((cells) => cells.map((value) => value.trim()));
}

/** True when the text is more than one cell, so it is spread over cells instead of typed into one. */
export function isCellBlock(text: string): boolean { const rows = parseCopiedCells(text); return rows.length > 1 || (rows[0]?.length ?? 0) > 1; }

/** The choice a pasted text names: by its value or its label, ignoring case and surrounding spaces. */
export function matchChoice(text: string, choices: readonly { readonly value: string; readonly label: string }[]): string | undefined {
  const wanted = text.trim().toLowerCase(); if (!wanted) return undefined;
  return (choices.find((choice) => choice.value.toLowerCase() === wanted) ?? choices.find((choice) => choice.label.trim().toLowerCase() === wanted))?.value;
}
