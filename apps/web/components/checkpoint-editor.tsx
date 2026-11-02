'use client';

// A checkpoint (PROD §5.3, D-24): its name, description, verification radius and status, and its
// position, set with a pin on the map with the radius drawn around it. Without a position its scans
// can only be "QR only" (PROD §9.3). The map shows the site's boundary and its other checkpoints; their
// names are drawn by the map's own text rendering, never as HTML (ADV-W01).
import type { Checkpoint, PatrolRoute, Site, SiteBoundary } from '@sentryops/contracts';
import { circlePolygon, haversineM, pointInPolygon } from '@sentryops/domain';
import { useMemo, useState, type FormEvent } from 'react';

import { api, ApiError, errorText } from '../lib/api';
import { RADIUS_M } from '../lib/patrols';
import { BoundaryMap, type MapShape } from './map';

type LatLng = { lat: number; lng: number };

/** Six decimals is about 10 cm: more than a map click can mean. */
const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

function inside(boundary: SiteBoundary, p: LatLng): boolean {
  return boundary.kind === 'CIRCLE'
    ? haversineM(boundary.center, p) <= boundary.radiusM
    : pointInPolygon(p, boundary.points);
}

function outline(boundary: SiteBoundary): LatLng[] {
  return boundary.kind === 'CIRCLE' ? circlePolygon(boundary.center, boundary.radiusM, 16) : boundary.points;
}

export function CheckpointEditor({
  site,
  checkpoint,
  checkpoints,
  routes,
  onClose,
  onSaved,
}: {
  site: Site;
  checkpoint: Checkpoint;
  /** The site's checkpoints, drawn around this one. */
  checkpoints: readonly Checkpoint[];
  /** The site's routes, to say which ones still use this checkpoint. */
  routes: readonly PatrolRoute[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(checkpoint.name);
  const [description, setDescription] = useState(checkpoint.description ?? '');
  const [radius, setRadius] = useState(String(checkpoint.verificationRadiusM));
  const [status, setStatus] = useState<Checkpoint['status']>(checkpoint.status);
  const [location, setLocation] = useState<LatLng | null>(checkpoint.location);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const radiusM = Number(radius);
  const radiusOk =
    radius.trim() !== '' && Number.isInteger(radiusM) && radiusM >= RADIUS_M.min && radiusM <= RADIUS_M.max;
  const previewRadius = Math.min(
    Math.max(Number.isFinite(radiusM) ? radiusM : RADIUS_M.min, RADIUS_M.min),
    RADIUS_M.max,
  );

  // The map opens on the site and its checkpoints, once; clicks then only move the pin.
  const [fit] = useState<LatLng[]>(() => [
    ...outline(site.boundary),
    ...checkpoints.flatMap((c) => (c.location ? [c.location] : [])),
  ]);
  const around = useMemo<MapShape[]>(
    () => [
      { id: site.id, name: site.name, boundary: site.boundary },
      ...checkpoints.flatMap((c) =>
        c.id !== checkpoint.id && c.location
          ? [
              {
                id: c.id,
                name: c.name,
                boundary: { kind: 'CIRCLE' as const, center: c.location, radiusM: c.verificationRadiusM },
              },
            ]
          : [],
      ),
    ],
    [site, checkpoints, checkpoint.id],
  );
  const label = name.trim() || checkpoint.name;
  const shapes = useMemo<MapShape[]>(
    () =>
      location
        ? [
            ...around,
            {
              id: checkpoint.id,
              name: label,
              boundary: { kind: 'CIRCLE', center: location, radiusM: previewRadius },
              highlight: true,
            },
          ]
        : around,
    [around, location, previewRadius, label, checkpoint.id],
  );

  const usedBy = routes
    .filter((r) => r.status === 'ACTIVE' && r.checkpoints.some((c) => c.checkpointId === checkpoint.id))
    .map((r) => r.name);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!radiusOk || !name.trim()) return;
    // Only what changed: the audit log lists the fields.
    const changes: Record<string, unknown> = {};
    if (name.trim() !== checkpoint.name) changes.name = name.trim();
    const desc = description.trim() || null;
    if (desc !== checkpoint.description) changes.description = desc;
    if (radiusM !== checkpoint.verificationRadiusM) changes.verificationRadiusM = radiusM;
    if (status !== checkpoint.status) changes.status = status;
    if (location?.lat !== checkpoint.location?.lat || location?.lng !== checkpoint.location?.lng)
      changes.location = location;
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    if (
      changes.status === 'ARCHIVED' &&
      !window.confirm(`Archive ${checkpoint.name}? Its label stops working and it leaves this site's list.`)
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await api<Checkpoint>(`/checkpoints/${checkpoint.id}`, {
        method: 'PATCH',
        body: { ...changes, version: checkpoint.version },
      });
      onSaved();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === 'VERSION_CONFLICT'
          ? `${errorText(e)} Close this and open the checkpoint again to see the latest version.`
          : errorText(e),
      );
      setBusy(false);
    }
  }

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="checkpoint-title"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <form className="dialog wide" onSubmit={(e) => void save(e)}>
        <div className="card-head">
          <h2 id="checkpoint-title">Edit {checkpoint.name}</h2>
          <button type="button" className="btn small ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
        {error ? <div className="banner error">{error}</div> : null}
        <div className="form-row">
          <label className="field">
            <span>Name</span>
            <input
              required
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>
          <label className="field">
            <span>Verification radius (m)</span>
            <input
              type="number"
              required
              min={RADIUS_M.min}
              max={RADIUS_M.max}
              step={1}
              value={radius}
              onChange={(e) => setRadius(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value as Checkpoint['status'])}>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive: its label is refused when scanned</option>
              <option value="ARCHIVED">Archived: label refused, not listed</option>
            </select>
          </label>
        </div>
        <p className="faint">
          A scan within {radiusOk ? radiusM : `${RADIUS_M.min}–${RADIUS_M.max}`} m of the pin, with good GPS,
          is “Verified”.
        </p>
        {status !== 'ACTIVE' && usedBy.length > 0 ? (
          <div className="banner warn">
            Still in {usedBy.join(', ')}. Guards can't scan it while it is {status.toLowerCase()}, so those
            rounds can't be completed: take it out of the route first.
          </div>
        ) : null}
        <label className="field">
          <span>Description (optional)</span>
          <textarea
            rows={2}
            maxLength={4000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <div className="row">
          <span className="muted">
            {location
              ? `Pinned at ${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}. Click the map to move it.`
              : 'Click the map to place the pin.'}
          </span>
          <button type="button" className="btn small" disabled={!location} onClick={() => setLocation(null)}>
            Remove pin
          </button>
        </div>
        {location ? (
          inside(site.boundary, location) ? null : (
            <div className="banner warn">The pin is outside the site's boundary. Check that it is right.</div>
          )
        ) : (
          <div className="banner warn">No position: scans of this checkpoint can only be “QR only”.</div>
        )}
        <BoundaryMap
          shapes={shapes}
          onPick={(p) => setLocation({ lat: round6(p.lat), lng: round6(p.lng) })}
          fit={fit}
          height="min(360px, 45vh)"
        />
        <div className="row">
          <button className="btn primary" disabled={busy || !radiusOk || !name.trim()}>
            {busy ? 'Saving…' : 'Save checkpoint'}
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
