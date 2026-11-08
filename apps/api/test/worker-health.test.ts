// The worker's heartbeat for the operator's alarms (ARCH §18.4): lag is how far past schedule the
// most overdue loop is, a stalled loop shows as lag, and the lines hold only names, counts and seconds.
import { describe, expect, it } from 'vitest';

import { heartbeatLine, JobClock, notificationRunLine } from '../src/workers/health.ts';

const S = 1000;

describe('job lag', () => {
  it('is zero while every loop comes round on time, and counts only the time past its schedule', () => {
    const clock = new JobClock();
    clock.register('send', 2 * S, 0);
    clock.register('retention', 3600 * S, 0);
    expect(clock.lag(1 * S)).toEqual({ job: null, seconds: 0 });
    expect(clock.lag(2 * S)).toEqual({ job: null, seconds: 0 });
    clock.done('send', 2 * S);
    expect(clock.lag(3 * S)).toEqual({ job: null, seconds: 0 });
  });

  it('a loop that never finishes again shows as rising lag, naming the loop', () => {
    const clock = new JobClock();
    clock.register('send', 2 * S, 0);
    clock.register('escalate', 5 * S, 0);
    clock.done('escalate', 5 * S);
    // 'send' is stuck since the start; 'escalate' kept running.
    expect(clock.lag(60 * S)).toEqual({ job: 'send', seconds: 58 });
    clock.done('escalate', 125 * S);
    expect(clock.lag(125 * S)).toEqual({ job: 'send', seconds: 123 });
    // It recovers the moment the loop finishes a round.
    clock.done('send', 126 * S);
    expect(clock.lag(127 * S).seconds).toBe(0);
  });

  it('reports the worst loop when several are late, and ignores a loop it does not know', () => {
    const clock = new JobClock();
    clock.register('a', 10 * S, 0);
    clock.register('b', 10 * S, 5 * S);
    clock.done('unknown', 100 * S);
    expect(clock.lag(100 * S)).toEqual({ job: 'a', seconds: 90 });
  });
});

describe('the lines the alarms read', () => {
  it('the heartbeat holds a name and seconds, nothing else', () => {
    const clock = new JobClock();
    clock.register('send', S, 0);
    expect(heartbeatLine(clock, 200 * S)).toEqual({
      msg: 'worker heartbeat',
      maxJobLagSeconds: 199,
      laggingJob: 'send',
    });
    expect(heartbeatLine(new JobClock(), 0)).toEqual({
      msg: 'worker heartbeat',
      maxJobLagSeconds: 0,
      laggingJob: null,
    });
  });

  it('a round that sent nothing and failed nothing logs nothing', () => {
    expect(notificationRunLine(0, 0)).toBeNull();
    expect(notificationRunLine(3, 1)).toEqual({ msg: 'notification run', sent: 3, failed: 1 });
  });
});
