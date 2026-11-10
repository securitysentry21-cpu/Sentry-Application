// A row of ticks showing parts of a whole, each in its state's colour. It only repeats numbers that
// are printed beside it in words, so screen readers skip it (aria-hidden).
import { allocateTicks } from '../lib/meter';

export type MeterTone = 'live' | 'delayed' | 'offline';

export function TickMeter({
  parts,
  total,
  ticks = 24,
  tone,
}: {
  parts: readonly { count: number; tone: MeterTone }[];
  total: number;
  ticks?: number;
  /** One part of one state: the unlit ticks take a faint step of that state's colour. */
  tone?: MeterTone;
}) {
  const filled = allocateTicks(
    parts.map((p) => p.count),
    total,
    ticks,
  );
  const cells: (MeterTone | undefined)[] = parts.flatMap((p, i) =>
    Array.from({ length: filled[i] ?? 0 }, () => p.tone),
  );
  while (cells.length < ticks) cells.push(undefined);
  return (
    <div className={tone ? `meter ${tone}` : 'meter'} aria-hidden="true">
      {cells.map((cell, i) => (
        <i key={i} className={cell} />
      ))}
    </div>
  );
}
