'use client';

// One SOS (PROD §11, §14.2): the guard and a button to call them, where they are (the newest SOS
// position and the trail behind it), what the server can prove so far (PROD §11.3, INV-10), every
// notification sent, and acknowledge and resolve. "I'm safe" from the guard is shown prominently but
// changes nothing: the SOS stays open (PROD §11.8). Each load is recorded in the audit log
// (SOS_VIEWED: the trail is location history, INV-14), so the page loads when it opens and when the
// stream says this SOS changed, never on a timer. A newer position alone arrives live on the stream
// and moves the marker without a reload (the trail catches up at the next change). Plain text only
// (ADV-W01); phone-width friendly for duty officers (D-04, PROD §14.7).
import type { Alert, Site, SosDetail, SosResolution } from '@sentryops/contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import { BoundaryMap, type MapPoint, type MapShape, type MapTrack } from '../../../../components/map';
import { PageHead } from '../../../../components/shell';
import {
  CancelNotice,
  DeliveriesTable,
  SosFacts,
  SosProgressList,
  SosStatusBadge,
} from '../../../../components/sos';
import { api, errorText } from '../../../../lib/api';
import { formatRelative, shortAge, zonedDateTime } from '../../../../lib/format';
import { useLive, useLiveEvents, useReloadOn } from '../../../../lib/live';
import { RESOLUTION_LABEL, RESOLUTION_NOTE_MAX, RESOLUTIONS, trailSegments } from '../../../../lib/sos';
import { useSession } from '../../../../lib/session';

/** Appendix B's freshness.location_current_max_s, until the live picture brings the organization's. */
const LOCATION_CURRENT_MAX_S = 150;

export default function SosPage() {
  const { id } = useParams<{ id: string }>();
  const { can, membership } = useSession();
  const { model, now, mergeAlert } = useLive();
  const [sos, setSos] = useState<SosDetail | null>(null);
  const [site, setSite] = useState<Site | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'acknowledge' | 'resolve' | null>(null);
  const [resolution, setResolution] = useState<SosResolution | ''>('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      setSos((await api<{ sos: SosDetail }>(`/sos/${id}`)).sos);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load, membership.organizationId]);

  useReloadOn(
    (e) =>
      e.type === 'resync' ||
      ((e.type === 'sos.activated' || e.type === 'sos.updated') &&
        e.data.sosEventId === id &&
        !e.data.positionOnly),
    load,
  );

  // Only the position moved: take it from the event, live like the live map's, with no history read.
  useLiveEvents((e) => {
    if (e.type !== 'sos.updated' || e.data.sosEventId !== id || !e.data.positionOnly) return;
    const moved = e.data.position;
    if (!moved) return;
    setSos((current) =>
      current && (!current.location || moved.capturedAt > current.location.capturedAt)
        ? { ...current, location: moved }
        : current,
    );
  });

  const siteId = sos?.site?.id;
  useEffect(() => {
    setSite(null);
    if (!siteId || !can('sites.read')) return;
    let cancelled = false;
    void api<Site>(`/sites/${siteId}`)
      .then((s) => !cancelled && setSite(s))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [siteId, can]);

  // The alarm follows the live picture: the server's copy of the alert stops it at once.
  const refreshAlert = async (alertId: string | null) => {
    if (!alertId) return;
    try {
      mergeAlert((await api<{ alert: Alert }>(`/alerts/${alertId}`)).alert);
    } catch {
      // the stream brings it
    }
  };

  async function acknowledge() {
    setBusy('acknowledge');
    setError(null);
    try {
      const result = await api<{ sos: SosDetail }>(`/sos/${id}/acknowledge`, { method: 'POST', body: {} });
      setSos(result.sos);
      await refreshAlert(result.sos.alertId);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function resolve(event: FormEvent) {
    event.preventDefault();
    if (!resolution || !note.trim()) return;
    setBusy('resolve');
    setError(null);
    try {
      const result = await api<{ sos: SosDetail }>(`/sos/${id}/resolve`, {
        method: 'POST',
        body: { resolution, note: note.trim() },
      });
      setSos(result.sos);
      setNote('');
      await refreshAlert(result.sos.alertId);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const trail = sos?.trail;
  const position = sos?.location ?? null;
  const track = useMemo<MapTrack | null>(
    () => (trail && trail.length > 0 ? { segments: trailSegments(trail), flagged: [], cursor: null } : null),
    [trail],
  );
  // Fitted once per SOS, when its first position arrives: later positions don't move the map under
  // the user.
  const hasPosition = Boolean(position) || (trail?.length ?? 0) > 0;
  const fit = useMemo(
    () => [...(trail ?? []), ...(position ? [position] : [])].map((p) => ({ lat: p.lat, lng: p.lng })),
    [sos?.id, hasPosition],
  );
  const shapes = useMemo<MapShape[]>(
    () => (site ? [{ id: site.id, name: site.name, boundary: site.boundary }] : []),
    [site],
  );

  if (error && !sos) {
    return (
      <>
        <div className="banner error">{error}</div>
        <Link className="btn" href="/alerts">
          Alerts
        </Link>
      </>
    );
  }
  if (!sos) return <div className="loading">Loading…</div>;

  const tz = sos.site?.timezone ?? membership.organizationTimezone;
  const currentMaxS = model?.freshness.locationCurrentMaxS ?? LOCATION_CURRENT_MAX_S;
  const current = position ? (now.getTime() - Date.parse(position.capturedAt)) / 1000 <= currentMaxS : false;
  const points: MapPoint[] = position
    ? [
        {
          id: sos.id,
          label: `${sos.guard.displayName} · ${shortAge(position.capturedAt, now)}`,
          lat: position.lat,
          lng: position.lng,
          // Hollow once the position is no longer current: never shown as live (INV-09).
          health: current ? 'LIVE' : 'DELAYED',
          current,
          accuracyM: position.accuracyM,
        },
      ]
    : [];

  return (
    <>
      <PageHead
        title={`SOS — ${sos.guard.displayName}`}
        description={`${sos.site ? sos.site.name : 'Off shift'} · pressed ${formatRelative(sos.activatedAt, now)}`}
        actions={<SosStatusBadge status={sos.status} />}
      />
      {sos.isDrill ? (
        <div className="banner warn" role="status">
          <span className="badge drill">DRILL</span> This SOS is part of a drill. It reaches only the members
          taking part, its notifications are marked [DRILL], and it is left out of statistics.
        </div>
      ) : null}
      <CancelNotice sos={sos} timeZone={tz} />
      {error ? <div className="banner error">{error}</div> : null}
      <div className="grid cols-2">
        <div className="card">
          <h2>Guard</h2>
          <SosFacts sos={sos} timeZone={tz} />
          {sos.status === 'ACTIVE' && can('sos.ack') ? (
            <button
              type="button"
              className="btn primary sos-ack"
              disabled={busy !== null}
              onClick={() => void acknowledge()}
            >
              {busy === 'acknowledge' ? 'Acknowledging…' : 'Acknowledge SOS'}
            </button>
          ) : null}
          {sos.status !== 'RESOLVED' && can('sos.resolve') ? (
            <form className="grid" onSubmit={(e) => void resolve(e)}>
              <h3>Resolve</h3>
              <label className="field">
                <span>What it was</span>
                <select
                  required
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value as SosResolution | '')}
                >
                  <option value="">Choose…</option>
                  {RESOLUTIONS.map((r) => (
                    <option key={r} value={r}>
                      {RESOLUTION_LABEL[r]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Note (required)</span>
                <textarea
                  rows={3}
                  required
                  maxLength={RESOLUTION_NOTE_MAX}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="What happened, and what was done"
                />
              </label>
              <div className="row">
                <button className="btn" disabled={busy !== null || !resolution || !note.trim()}>
                  {busy === 'resolve' ? 'Resolving…' : 'Resolve SOS'}
                </button>
              </div>
            </form>
          ) : null}
        </div>
        <div className="card">
          <h2>What the server can confirm</h2>
          <SosProgressList sos={sos} timeZone={tz} />
          <p className="faint">
            “Alert sent” means a provider accepted a push or text, not that anyone saw it. “Notified” needs a
            dashboard showing the alarm or a phone confirming the push.
          </p>
        </div>
      </div>
      <div className="card">
        <h2>Where the guard is</h2>
        {position || (trail?.length ?? 0) > 0 ? (
          <>
            <BoundaryMap shapes={shapes} points={points} track={track} fit={fit} height="min(420px, 55vh)" />
            <p className="muted">
              {position
                ? `Newest SOS position: ${formatRelative(position.capturedAt, now)}${
                    position.accuracyM !== null ? ` · ±${Math.round(position.accuracyM)} m` : ''
                  } · ${zonedDateTime(position.capturedAt, tz, true)}${current ? '' : ' · last known, not current'}`
                : 'No SOS position yet.'}
              {trail && trail.length > 0
                ? ` The line is the SOS trail (${trail.length} points); gaps over 5 minutes are breaks.`
                : ''}
            </p>
          </>
        ) : (
          <p className="muted">
            No position yet. The phone sends one as soon as it has a fix, then every few seconds while the SOS
            is open.
          </p>
        )}
      </div>
      <div className="card">
        <h2>Notifications</h2>
        <DeliveriesTable sos={sos} timeZone={tz} />
      </div>
    </>
  );
}
