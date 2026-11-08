// Numbers for the load harness: percentiles, bounded concurrency, and the report it prints and keeps.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? Number.NaN;
}

/** Latencies in milliseconds. */
export class Samples {
  readonly values: number[] = [];
  add(ms: number): void {
    this.values.push(ms);
  }
  get count(): number {
    return this.values.length;
  }
  p(p: number): number {
    return percentile(this.values, p);
  }
}

/** Runs `work` over `items`, at most `limit` at once, keeping the order of results. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await work(items[index] as T, index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Times an async call in milliseconds. */
export async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await work();
  return { value, ms: performance.now() - start };
}

export type ReportRow = {
  readonly scenario: string;
  readonly measure: string;
  readonly result: string;
  /** The ARCH §18.3 target, when there is one. */
  readonly target: string;
  /** `within`, `above`, `info` (no target) or `not comparable` (the run was smaller than the target's). */
  readonly verdict: 'within' | 'above' | 'info' | 'not comparable';
};

export class Report {
  readonly rows: ReportRow[] = [];
  readonly notes: string[] = [];

  add(row: ReportRow): void {
    this.rows.push(row);
    console.log(
      `  ${row.scenario.padEnd(22)} ${row.measure.padEnd(46)} ${row.result.padEnd(22)} ${row.verdict}`,
    );
  }

  note(text: string): void {
    this.notes.push(text);
    console.log(`  note: ${text}`);
  }

  markdown(header: string[]): string {
    const lines = [
      ...header,
      '',
      '| Scenario | Measure | Result | Target | Verdict |',
      '|---|---|---|---|---|',
    ];
    for (const r of this.rows) {
      lines.push(`| ${r.scenario} | ${r.measure} | ${r.result} | ${r.target} | ${r.verdict} |`);
    }
    if (this.notes.length > 0) lines.push('', ...this.notes.map((n) => `- ${n}`));
    return `${lines.join('\n')}\n`;
  }

  write(path: string, header: string[]): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, this.markdown(header), 'utf8');
  }
}

export const ms = (value: number): string => (Number.isFinite(value) ? `${Math.round(value)} ms` : 'n/a');
