import fs from 'node:fs';
import path from 'node:path';

export function printJsonOrText(opts, value, printText) {
  if (opts.out) {
    const out = path.resolve(opts.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
  if (opts.json) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    printText(value);
    if (opts.out) console.log(`JSON: ${path.resolve(opts.out)}`);
  }
}

export function writeCsv(file, rows, columns) {
  const out = path.resolve(file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column])).join(','));
  fs.writeFileSync(out, `\uFEFF${lines.join('\n')}\n`, 'utf8');
  return out;
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}
