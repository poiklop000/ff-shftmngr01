function csvEscape(value: string | number | null | undefined): string {
  const str = String(value ?? '');
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function downloadCsv(filename: string, header: string[], rows: (string | number | null | undefined)[][]) {
  const lines: string[] = [];
  lines.push(header.map(csvEscape).join(','));
  for (const row of rows) lines.push(row.map(csvEscape).join(','));
  const csv = '\uFEFF' + lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
