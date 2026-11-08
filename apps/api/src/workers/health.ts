// The worker's own health for the operator's alarms (ARCH §18.3, §18.4). Every loop reports when it
// finishes a round; a heartbeat line says how far behind schedule the most overdue loop is, so a loop
// that hangs shows as rising lag, and a dead worker shows as heartbeats that stop. Lag is the time
// past the moment the loop should have come round again; the target is 2 minutes. Counts and
// seconds only (SEC §15).
export type JobLag = { readonly job: string | null; readonly seconds: number };

export class JobClock {
  readonly #jobs = new Map<string, { intervalMs: number; lastDoneMs: number }>();

  /** A loop that runs again `intervalMs` after each round. It counts as just done at `nowMs`. */
  register(job: string, intervalMs: number, nowMs: number): void {
    this.#jobs.set(job, { intervalMs, lastDoneMs: nowMs });
  }

  done(job: string, nowMs: number): void {
    const entry = this.#jobs.get(job);
    if (entry) entry.lastDoneMs = nowMs;
  }

  /** The most overdue loop and by how many seconds (0 when none is late). */
  lag(nowMs: number): JobLag {
    let worst: JobLag = { job: null, seconds: 0 };
    for (const [job, { intervalMs, lastDoneMs }] of this.#jobs) {
      const overdue = Math.max(0, nowMs - (lastDoneMs + intervalMs)) / 1000;
      if (overdue > worst.seconds) worst = { job, seconds: Math.round(overdue) };
    }
    return worst;
  }
}

/** The line the heartbeat logs; the metric filters in infra/terraform/cell/operations.tf read it. */
export function heartbeatLine(clock: JobClock, nowMs: number): Record<string, unknown> {
  const lag = clock.lag(nowMs);
  return { msg: 'worker heartbeat', maxJobLagSeconds: lag.seconds, laggingJob: lag.job };
}

/** The line the sender logs after a round that sent or failed something. */
export function notificationRunLine(sent: number, failed: number): Record<string, unknown> | null {
  return sent + failed > 0 ? { msg: 'notification run', sent, failed } : null;
}
