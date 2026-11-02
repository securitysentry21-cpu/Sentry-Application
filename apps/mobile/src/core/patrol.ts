// Patrol rounds on the phone (PROD §7.7): which round to show, what to scan next, and whether a
// scanned code is a checkpoint label at all. Pure, so it is tested without a phone. The server
// judges every scan; nothing here decides whether a checkpoint counts (INV-11).
import type { GuardPatrolRun } from '@sentryops/contracts';

/** A checkpoint label holds `SG1:` and a 22-character token (ARCH §11.1); never a web address. */
export function isCheckpointLabel(content: string): boolean {
  return /^SG1:[A-Za-z0-9_-]{22}$/.test(content.trim());
}

export type RoundsView = {
  /** The round to work on: the open one whose window holds now, else the next one due. */
  readonly current: GuardPatrolRun | null;
  /** Rounds still to come after the current one, soonest first. */
  readonly upcoming: readonly GuardPatrolRun[];
};

const OPEN = new Set<GuardPatrolRun['status']>(['PENDING', 'IN_PROGRESS']);

export function roundsView(runs: readonly GuardPatrolRun[], nowMs: number, limit = 3): RoundsView {
  const open = runs
    .filter((r) => OPEN.has(r.status) && Date.parse(r.windowEndsAt) >= nowMs)
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  const current = open.find((r) => Date.parse(r.dueAt) <= nowMs) ?? open[0] ?? null;
  return { current, upcoming: open.filter((r) => r !== current).slice(0, limit) };
}

/** The first required checkpoint in route order that isn't done yet. */
export function nextCheckpoint(run: GuardPatrolRun): GuardPatrolRun['checkpoints'][number] | null {
  return (
    [...run.checkpoints].sort((a, b) => a.sequence - b.sequence).find((c) => c.required && c.done === null) ??
    null
  );
}
