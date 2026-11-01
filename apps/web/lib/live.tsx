'use client';

// One live picture per dashboard tab, shared by every page (ARCH §14, PROD §14.7): the snapshot,
// then the stream from exactly where the snapshot ended. An open tab counts as a connected
// dashboard for monitoring coverage (PROD §11.5). If the stream is down, freshness keeps counting
// locally against server time; after 10 s the shell says so; on reconnect the picture reloads.
import type { Alert, Snapshot } from '@sentryops/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { api, errorText, notifySignedOut } from './api';
import { applyEvent, fromSnapshot, type Envelope, type LiveModel, type Reload } from './live-model';
import { useSession } from './session';
import { connectStream, type StreamStatus } from './stream';

type Live = {
  /** Null until the first snapshot, or without permission to see live data. */
  readonly model: LiveModel | null;
  /** Server time, ticking every second (ages use server time, PROD §14.7). */
  readonly now: Date;
  readonly status: StreamStatus;
  /** How long the stream has been down; 0 while it is open. */
  readonly disconnectedMs: number;
  readonly error: string | null;
  readonly reload: () => void;
};

const LiveContext = createContext<Live | null>(null);
const RELOAD_DEBOUNCE_MS = 500;
/** How long a started shift may take to arrive by itself before the snapshot is reloaded for it. */
const MISSING_GRACE_MS = 3_000;
/** Counts alone (shifts not started) refresh at most this often. */
const COUNTS_EVERY_MS = 60_000;

function clientKind(): 'desktop' | 'phone' {
  try {
    return window.matchMedia('(max-width: 700px), (pointer: coarse)').matches ? 'phone' : 'desktop';
  } catch {
    return 'desktop';
  }
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const { can, membership } = useSession();
  const enabled = can('live.read');
  const canAlerts = can('alerts.read');
  const [model, setModel] = useState<LiveModel | null>(null);
  const modelRef = useRef<LiveModel | null>(null);
  const [offsetMs, setOffsetMs] = useState(0);
  const [tick, setTick] = useState(() => Date.now());
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [downSince, setDownSince] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reloadTimer = useRef<number | null>(null);
  const lastLoad = useRef(0);
  const missing = useRef(new Set<string>());
  // Events that arrive while a snapshot is loading are applied on top of it.
  const pending = useRef<Envelope[] | null>(null);
  const wasDown = useRef(false);

  const commit = useCallback((next: LiveModel | null) => {
    modelRef.current = next;
    setModel(next);
  }, []);

  const load = useCallback(async () => {
    pending.current = [];
    lastLoad.current = Date.now();
    missing.current.clear();
    try {
      const snapshot = await api<Snapshot>('/dashboard/snapshot');
      const alerts = canAlerts
        ? (await api<{ alerts: Alert[] }>('/alerts?status=active&limit=500')).alerts
        : [];
      setOffsetMs(new Date(snapshot.serverTime).getTime() - Date.now());
      let next = fromSnapshot(snapshot, alerts);
      // Keep the stream's position if it is already further on; replay what came in meanwhile.
      next = { ...next, lastEventId: Math.max(next.lastEventId, modelRef.current?.lastEventId ?? 0) };
      for (const event of pending.current ?? []) {
        if (event.id !== null && Number(event.id) > snapshot.lastEventId)
          next = applyEvent(next, event).model;
      }
      commit(next);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      pending.current = null;
    }
  }, [canAlerts, commit]);

  const scheduleReload = useCallback(
    (delayMs = RELOAD_DEBOUNCE_MS) => {
      if (reloadTimer.current !== null) return;
      reloadTimer.current = window.setTimeout(() => {
        reloadTimer.current = null;
        void load();
      }, delayMs);
    },
    [load],
  );

  const handleReload = useCallback(
    (reload: Reload) => {
      if (reload === false) return;
      if (reload === 'now') return scheduleReload();
      if (reload === 'counts') {
        return scheduleReload(Math.max(RELOAD_DEBOUNCE_MS, lastLoad.current + COUNTS_EVERY_MS - Date.now()));
      }
      missing.current.add(reload.missing);
      window.setTimeout(() => {
        const known = modelRef.current?.guards;
        if ([...missing.current].some((id) => !known?.has(id))) scheduleReload();
      }, MISSING_GRACE_MS);
    },
    [scheduleReload],
  );

  useEffect(() => {
    if (!enabled) {
      commit(null);
      return;
    }
    let stop: (() => void) | null = null;
    let cancelled = false;
    commit(null);
    void load().then(() => {
      if (cancelled) return;
      stop = connectStream({
        organizationId: membership.organizationId,
        client: clientKind(),
        lastEventId: () => modelRef.current?.lastEventId ?? 0,
        onEvent: (event) => {
          pending.current?.push(event);
          const current = modelRef.current;
          if (!current) return;
          const applied = applyEvent(current, event);
          commit(applied.model);
          handleReload(applied.reload);
        },
        onStatus: (next) => {
          setStatus(next);
          if (next === 'open') {
            setDownSince(null);
            // PROD §14.7: after a disconnection, reload the current state.
            if (wasDown.current) scheduleReload();
            wasDown.current = false;
          } else {
            wasDown.current = true;
            setDownSince((since) => since ?? Date.now());
          }
        },
        onRefused: notifySignedOut,
      });
    });
    return () => {
      cancelled = true;
      stop?.();
      if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current);
      reloadTimer.current = null;
    };
  }, [enabled, membership.organizationId, load, commit, scheduleReload, handleReload]);

  useEffect(() => {
    const clock = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(clock);
  }, []);

  const value = useMemo<Live>(
    () => ({
      model,
      now: new Date(tick + offsetMs),
      status,
      disconnectedMs: downSince === null ? 0 : Math.max(0, tick - downSince),
      error,
      reload: () => void load(),
    }),
    [model, tick, offsetMs, status, downSince, error, load],
  );
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): Live {
  const live = useContext(LiveContext);
  if (!live) throw new Error('useLive outside LiveProvider');
  return live;
}
