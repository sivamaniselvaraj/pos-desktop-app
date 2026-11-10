/** CSV download for the report tabs (UTF-8 with BOM so Excel shows Tamil names and ₹ correctly). */
export type CsvCell = string | number | null | undefined;

function cell(v: CsvCell): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows are written as given; pass [] for a blank line between sections. */
export function downloadCsv(fileName: string, rows: CsvCell[][]): void {
  const text = rows.map((r) => r.map(cell).join(',')).join('\r\n');
  const blob = new Blob([`${String.fromCharCode(0xfeff)}${text}\r\n`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

/** Money as a plain number with two decimals, for CSV cells. */
export const m2 = (n: number): string => n.toFixed(2);
