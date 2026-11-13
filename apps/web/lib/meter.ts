// How a tick meter shares out its ticks (components/meter.tsx). Each part fills its share of the
// whole, rounded by largest remainder; a part above zero always lights at least one tick, so one
// offline guard among a thousand still shows (the map's clusters follow the same rule).

/** Ticks filled by each part, in order. Their sum never exceeds `ticks` unless more parts than ticks are above zero. */
export function allocateTicks(counts: readonly number[], total: number, ticks: number): number[] {
  const parts = counts.map((c) => (Number.isFinite(c) && c > 0 ? c : 0));
  const sum = parts.reduce((a, b) => a + b, 0);
  if (!(total > 0) || sum === 0 || ticks <= 0) return parts.map(() => 0);
  const target = Math.min(ticks, Math.round((Math.min(sum, total) / total) * ticks));
  const exact = parts.map((c) => (c / total) * ticks);
  const filled = parts.map((c, i) => (c > 0 ? Math.max(1, Math.floor(exact[i]!)) : 0));
  let spare = target - filled.reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((x, i) => ({ i, remainder: x - Math.floor(x) }))
    .sort((a, b) => b.remainder - a.remainder);
  for (const { i } of byRemainder) {
    if (spare <= 0) break;
    if (parts[i]! > 0) {
      filled[i]! += 1;
      spare -= 1;
    }
  }
  // The at-least-one rule can overshoot: take ticks back from the largest parts, never below one.
  while (spare < 0) {
    const largest = filled.indexOf(Math.max(...filled));
    if (filled[largest]! <= 1) break;
    filled[largest]! -= 1;
    spare += 1;
  }
  return filled;
}
