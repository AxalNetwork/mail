const cell = (v: string | number) => { const t = String(v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };

export function toCsv(rows: (string | number)[][]): string {
  return rows.map(r => r.map(cell).join(',')).join('\n') + '\n';
}

/** Hand the browser a CSV file to save. Nothing leaves the device. */
export function downloadCsv(name: string, csv: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
