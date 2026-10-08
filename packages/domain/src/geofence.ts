// Departure and return (PROD §8.4), one usable fix at a time, in capture order. Pure: the worker
// feeds it points since its watermark and stores the state it returns.
//   - Unusable fixes (accuracy unknown or worse than the usable limit) never change the state (G04).
//   - Departure is confirmed only after N outside fixes spanning the persistence time with no inside
//     fix in between; uncertain fixes neither confirm nor cancel (G01, G02).
//   - Return: one inside fix with good accuracy, or two consecutive inside fixes (G05).
//   - No data is not evidence: without new fixes the state simply stays (G06).
import { classifyFix, type Boundary, type Point } from './geo.ts';

export type GeofenceState = 'UNKNOWN' | 'INSIDE' | 'UNCERTAIN' | 'OUTSIDE_SUSPECTED' | 'OUTSIDE_CONFIRMED';

export type GeofenceMemory = {
  readonly state: GeofenceState;
  /** First outside fix of the current excursion (suspected or confirmed). */
  readonly outsideSince: Date | null;
  readonly outsidePoints: number;
  /** Consecutive inside fixes while OUTSIDE_CONFIRMED (two confirm a return). */
  readonly insideStreak: number;
};

export const INITIAL_GEOFENCE: GeofenceMemory = {
  state: 'UNKNOWN',
  outsideSince: null,
  outsidePoints: 0,
  insideStreak: 0,
};

export type GeofenceSettings = {
  readonly maxUsableAccuracyM: number; // geofence.max_usable_accuracy_m (100)
  readonly outsideBufferM: number; // geofence.outside_buffer_m (25)
  readonly departurePersistenceS: number; // geofence.departure_persistence_s (300)
  readonly departureMinPoints: number; // geofence.departure_min_points (3)
  readonly returnAccuracyM: number; // geofence.return_accuracy_m (50)
};

export type GeofenceEvent =
  | { readonly type: 'LEFT_SITE'; readonly at: Date; readonly since: Date }
  | { readonly type: 'ENTERED_SITE'; readonly at: Date; readonly outsideSeconds: number };

export function stepGeofence(
  memory: GeofenceMemory,
  boundary: Boundary,
  fix: Point & { readonly accuracyM: number | null; readonly capturedAt: Date },
  s: GeofenceSettings,
): { memory: GeofenceMemory; event: GeofenceEvent | null } {
  if (fix.accuracyM === null || fix.accuracyM > s.maxUsableAccuracyM) return { memory, event: null };
  const klass = classifyFix(boundary, fix, fix.accuracyM, s.outsideBufferM);

  if (memory.state === 'OUTSIDE_CONFIRMED') {
    if (klass !== 'INSIDE') return { memory: { ...memory, insideStreak: 0 }, event: null };
    const streak = memory.insideStreak + 1;
    if (fix.accuracyM <= s.returnAccuracyM || streak >= 2) {
      const since = memory.outsideSince ?? fix.capturedAt;
      return {
        memory: { state: 'INSIDE', outsideSince: null, outsidePoints: 0, insideStreak: 0 },
        event: {
          type: 'ENTERED_SITE',
          at: fix.capturedAt,
          outsideSeconds: Math.round((fix.capturedAt.getTime() - since.getTime()) / 1000),
        },
      };
    }
    return { memory: { ...memory, insideStreak: streak }, event: null };
  }

  if (klass === 'INSIDE')
    return {
      memory: { state: 'INSIDE', outsideSince: null, outsidePoints: 0, insideStreak: 0 },
      event: null,
    };
  if (klass === 'UNCERTAIN') {
    // Neither confirms nor cancels a suspected departure.
    return {
      memory: memory.state === 'OUTSIDE_SUSPECTED' ? memory : { ...memory, state: 'UNCERTAIN' },
      event: null,
    };
  }
  // OUTSIDE
  const since =
    memory.state === 'OUTSIDE_SUSPECTED' && memory.outsideSince ? memory.outsideSince : fix.capturedAt;
  const points = memory.state === 'OUTSIDE_SUSPECTED' ? memory.outsidePoints + 1 : 1;
  const spanS = (fix.capturedAt.getTime() - since.getTime()) / 1000;
  if (points >= s.departureMinPoints && spanS >= s.departurePersistenceS) {
    return {
      memory: { state: 'OUTSIDE_CONFIRMED', outsideSince: since, outsidePoints: points, insideStreak: 0 },
      event: { type: 'LEFT_SITE', at: fix.capturedAt, since },
    };
  }
  return {
    memory: { state: 'OUTSIDE_SUSPECTED', outsideSince: since, outsidePoints: points, insideStreak: 0 },
    event: null,
  };
}
