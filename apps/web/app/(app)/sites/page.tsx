'use client';

// Sites (D-38): posts and gates as circles, patrol beats as polygons drawn on the map. The server
// re-validates every boundary (no self-crossing, at most 100 km²). Checkpoints and their QR labels
// are managed per site; printing labels is a separate, audited page.
import type { Checkpoint, Site, SiteBoundary } from '@sentryops/contracts';
import { polygonAreaKm2 } from '@sentryops/domain';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import { BoundaryMap, type MapShape } from '../../../components/map';
import { PageHead } from '../../../components/shell';
import { api, errorText } from '../../../lib/api';
import { useSession } from '../../../lib/session';

type LatLng = { lat: number; lng: number };
type Draft =
  { kind: 'CIRCLE'; center: LatLng | null; radiusM: number } | { kind: 'POLYGON'; points: LatLng[] };

function draftBoundary(d: Draft): SiteBoundary | null {
  if (d.kind === 'CIRCLE') return d.center ? { kind: 'CIRCLE', center: d.center, radiusM: d.radiusM } : null;
  return d.points.length >= 3 ? { kind: 'POLYGON', points: d.points } : null;
}

export default function SitesPage() {
  const { can, membership } = useSession();
  const [sites, setSites] = useState<Site[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      setSites((await api<{ sites: Site[] }>('/sites')).sites);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, membership.organizationId]);

  const selected = sites?.find((s) => s.id === selectedId) ?? null;
  const shapes = useMemo<MapShape[]>(
    () =>
      (sites ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        boundary: s.boundary,
        highlight: s.id === selectedId,
      })),
    [sites, selectedId],
  );

  return (
    <>
      <PageHead
        title="Sites"
        description="Posts and gates are circles; patrol beats are boundaries drawn on the map."
        actions={
          can('sites.write') && !editing ? (
            <button
              className="btn primary"
              onClick={() => {
                setSelectedId(null);
                setEditing(true);
              }}
            >
              New site
            </button>
          ) : null
        }
      />
      {error ? <div className="banner error">{error}</div> : null}
      {editing ? (
        <SiteEditor
          site={selected}
          others={shapes.filter((s) => s.id !== selected?.id)}
          onDone={(id) => {
            setEditing(false);
            if (id) setSelectedId(id);
            void load();
          }}
        />
      ) : (
        <div className="grid cols-2">
          <div className="card">
            <BoundaryMap shapes={shapes} {...(selected ? { center: selected.center } : {})} height={460} />
          </div>
          <div className="card">
            <h2>All sites {sites ? <span className="faint">({sites.length})</span> : null}</h2>
            {sites === null ? (
              <div className="loading">Loading…</div>
            ) : sites.length === 0 ? (
              <div className="empty">No sites yet.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Boundary</th>
                      <th>Checkpoints</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {sites.map((s) => (
                      <tr key={s.id} aria-selected={s.id === selectedId}>
                        <td>
                          {s.name}
                          {s.clientName ? <div className="faint">{s.clientName}</div> : null}
                        </td>
                        <td className="muted">
                          {s.boundary.kind === 'CIRCLE'
                            ? `circle ${s.boundary.radiusM} m`
                            : `beat ${polygonAreaKm2(s.boundary.points).toFixed(2)} km²`}
                        </td>
                        <td>{s.checkpointCount}</td>
                        <td>
                          <button className="btn small" onClick={() => setSelectedId(s.id)}>
                            Open
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
      {selected && !editing ? (
        <SiteDetail site={selected} onEdit={() => setEditing(true)} onChanged={() => void load()} />
      ) : null}
    </>
  );
}

function SiteEditor({
  site,
  others,
  onDone,
}: {
  site: Site | null;
  others: MapShape[];
  onDone: (id: string | null) => void;
}) {
  const [name, setName] = useState(site?.name ?? '');
  const [clientName, setClientName] = useState(site?.clientName ?? '');
  const [draft, setDraft] = useState<Draft>(() =>
    site?.boundary.kind === 'POLYGON'
      ? { kind: 'POLYGON', points: [...site.boundary.points] }
      : {
          kind: 'CIRCLE',
          center: site?.boundary.kind === 'CIRCLE' ? site.boundary.center : null,
          radiusM: site?.boundary.kind === 'CIRCLE' ? site.boundary.radiusM : 150,
        },
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const boundary = draftBoundary(draft);

  const preview: MapShape[] = boundary
    ? [...others, { id: 'draft', name: name || 'New site', boundary, highlight: true }]
    : others;

  function pick(point: LatLng) {
    setDraft((d) => (d.kind === 'CIRCLE' ? { ...d, center: point } : { ...d, points: [...d.points, point] }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!boundary) return;
    setBusy(true);
    setError(null);
    try {
      const body = { name, clientName: clientName || null, boundary };
      const saved = site
        ? await api<Site>(`/sites/${site.id}`, { method: 'PATCH', body: { ...body, version: site.version } })
        : await api<Site>('/sites', { method: 'POST', body });
      onDone(saved.id);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={(e) => void save(e)}>
      <div className="card-head">
        <h2>{site ? `Edit ${site.name}` : 'New site'}</h2>
        <button type="button" className="btn ghost" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
      {error ? <div className="banner error">{error}</div> : null}
      <div className="form-row">
        <label className="field">
          <span>Name</span>
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Client (optional)</span>
          <input value={clientName} onChange={(e) => setClientName(e.target.value)} />
        </label>
        <label className="field">
          <span>Boundary</span>
          <select
            value={draft.kind}
            onChange={(e) =>
              setDraft(
                e.target.value === 'CIRCLE'
                  ? { kind: 'CIRCLE', center: null, radiusM: 150 }
                  : { kind: 'POLYGON', points: [] },
              )
            }
          >
            <option value="CIRCLE">Circle (post or gate)</option>
            <option value="POLYGON">Drawn boundary (patrol beat)</option>
          </select>
        </label>
      </div>
      {draft.kind === 'CIRCLE' ? (
        <div className="row">
          <span className="muted">
            {draft.center ? 'Click the map to move the centre.' : 'Click the map to place the centre.'}
          </span>
          <label className="row">
            <span className="faint">Radius (m)</span>
            <input
              type="number"
              min={50}
              max={5000}
              value={draft.radiusM}
              onChange={(e) => setDraft({ ...draft, radiusM: Number(e.target.value) })}
              style={{ width: 100 }}
            />
          </label>
        </div>
      ) : (
        <div className="row">
          <span className="muted">
            Click the map to add corners in order ({draft.points.length} so far
            {draft.points.length >= 3 ? `, ${polygonAreaKm2(draft.points).toFixed(2)} km²` : ', at least 3'}).
          </span>
          <button
            type="button"
            className="btn small"
            disabled={draft.points.length === 0}
            onClick={() => setDraft({ ...draft, points: draft.points.slice(0, -1) })}
          >
            Undo corner
          </button>
          <button
            type="button"
            className="btn small"
            disabled={draft.points.length === 0}
            onClick={() => setDraft({ ...draft, points: [] })}
          >
            Clear
          </button>
        </div>
      )}
      <BoundaryMap
        shapes={preview}
        onPick={pick}
        {...(draft.kind === 'POLYGON' ? { draft: draft.points } : {})}
        {...(site ? { center: site.center } : {})}
        height={480}
      />
      <div className="row">
        <button className="btn primary" disabled={busy || !boundary || !name}>
          {busy ? 'Saving…' : 'Save site'}
        </button>
      </div>
    </form>
  );
}

function SiteDetail({ site, onEdit, onChanged }: { site: Site; onEdit: () => void; onChanged: () => void }) {
  const { can } = useSession();
  const [checkpoints, setCheckpoints] = useState<Checkpoint[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setCheckpoints((await api<{ checkpoints: Checkpoint[] }>(`/sites/${site.id}/checkpoints`)).checkpoints);
    } catch (e) {
      setError(errorText(e));
    }
  }, [site.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await api(`/sites/${site.id}/checkpoints`, { method: 'POST', body: { name } });
      setName('');
      await load();
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>{site.name}</h2>
        <div className="row">
          {can('checkpoints.qr.print') ? (
            <Link className="btn" href={`/sites/${site.id}/print`}>
              Print QR labels
            </Link>
          ) : null}
          {can('sites.write') ? (
            <button className="btn" onClick={onEdit}>
              Edit site
            </button>
          ) : null}
        </div>
      </div>
      {error ? <div className="banner error">{error}</div> : null}
      <h3>Checkpoints</h3>
      {checkpoints === null ? (
        <div className="loading">Loading…</div>
      ) : checkpoints.length === 0 ? (
        <div className="empty">No checkpoints yet.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>QR version</th>
                <th>Radius</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {checkpoints.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="mono">v{c.qrVersion}</td>
                  <td className="muted">{c.verificationRadiusM} m</td>
                  <td>
                    {can('checkpoints.write') ? (
                      <button
                        className="btn small"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Replace the QR label of ${c.name}? The printed label stops working at once.`,
                            )
                          ) {
                            void api(`/checkpoints/${c.id}/rotate-qr`, { method: 'POST' })
                              .then(load)
                              .catch((e: unknown) => setError(errorText(e)));
                          }
                        }}
                      >
                        New QR label
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {can('checkpoints.write') ? (
        <form className="row" onSubmit={(e) => void add(e)}>
          <input
            required
            placeholder="New checkpoint name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Checkpoint name"
          />
          <button className="btn">Add checkpoint</button>
        </form>
      ) : null}
    </div>
  );
}
