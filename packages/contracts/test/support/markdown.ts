import { readFileSync } from 'node:fs';

const DOCS = new URL('../../../../docs/', import.meta.url);

export function readDoc(name: string): string {
  return readFileSync(new URL(name, DOCS), 'utf8');
}

/** Text from the heading that starts with `headingPrefix` up to the next heading of the same or higher level. */
export function section(markdown: string, headingPrefix: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.startsWith(headingPrefix));
  if (start === -1) throw new Error(`heading not found: ${headingPrefix}`);
  const level = /^#+/.exec(headingPrefix)?.[0].length ?? 2;
  const end = lines.findIndex(
    (line, i) => i > start && /^#+ /.test(line) && (/^#+/.exec(line)?.[0].length ?? 99) <= level,
  );
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

/** Body rows of the first pipe table in `text`, as trimmed cells. */
export function tableRows(text: string): string[][] {
  const rows = text
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) =>
      line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => cell.trim()),
    );
  // Drop the header row and the |---| separator row.
  return rows.slice(2);
}

export function stripMarkdown(cell: string): string {
  return cell.replace(/`/g, '').replace(/\*\*/g, '').trim();
}
