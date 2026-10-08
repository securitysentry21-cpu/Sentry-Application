'use client';

// Guards: the roster, CSV import, phone enrollment and devices (PROD §4, D-31). Enrollment codes
// are shown once, as text and as a QR code, for the supervisor to hand over in person (round 6).
import type { Guard } from '@sentryops/contracts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { QrCode } from '../../../components/qr';
import { PageHead } from '../../../components/shell';
import { api, errorText } from '../../../lib/api';
import { formatDateTime } from '../../../lib/format';
import { useSession } from '../../../lib/session';

type Device = {
  id: string;
  platform: string;
  manufacturer: string | null;
  model: string | null;
  appVersion: string | null;
  status: 'ACTIVE' | 'REVOKED';
  revokedReason: string | null;
  lastSeenAt: string | null;
  createdAt: string;
};

type Code = { code: string; qrPayload: string; expiresAt: string; purpose: string };

const STATUS_BADGE: Record<string, string> = {
  ACTIVE: 'ok',
  INACTIVE: 'warn',
  SUSPENDED: 'danger',
  TERMINATED: 'danger',
};

export default function GuardsPage() {
  const { can, membership } = useSession();
  const tz = membership.organizationTimezone;
  const [guards, setGuards] = useState<Guard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Guard | null>(null);

  const load = useCallback(async () => {
    try {
      setGuards((await api<{ guards: Guard[] }>('/guards')).guards);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, membership.organizationId]);

  const shown = (guards ?? []).filter((g) =>
    `${g.displayName} ${g.employeeNumber} ${g.phone}`.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <>
      <PageHead
        title="Guards"
        description="The guard roster. Each guard uses the SENTRY app on their own phone, enrolled with a one-time code."
      />
      {error ? <div className="banner error">{error}</div> : null}
      {can('guards.write') ? (
        <div className="grid cols-2">
          <AddGuard onAdded={() => void load()} />
          <ImportGuards onImported={() => void load()} />
        </div>
      ) : null}

      <div className="card">
        <div className="card-head">
          <h2>Roster {guards ? <span className="faint">({guards.length})</span> : null}</h2>
          <input
            placeholder="Search name, number or phone"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Search guards"
          />
        </div>
        {guards === null ? (
          <div className="loading">Loading…</div>
        ) : shown.length === 0 ? (
          <div className="empty">No guards yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Name</th>
                  <th>Phone</th>
                  <th>Status</th>
                  <th>App</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((g) => (
                  <tr key={g.id}>
                    <td className="mono">{g.employeeNumber}</td>
                    <td>{g.displayName}</td>
                    <td className="mono muted">{g.phone}</td>
                    <td>
                      <span className={`badge ${STATUS_BADGE[g.status] ?? ''}`}>
                        {g.status.toLowerCase()}
                      </span>
                    </td>
                    <td>
                      {g.enrolled ? (
                        <span className="badge ok">enrolled</span>
                      ) : (
                        <span className="badge plain">not enrolled</span>
                      )}
                    </td>
                    <td>
                      <button className="btn small" onClick={() => setSelected(g)}>
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
      {selected ? (
        <GuardDialog
          guard={selected}
          timezone={tz}
          onClose={() => setSelected(null)}
          onChanged={(g) => {
            setSelected(g);
            void load();
          }}
        />
      ) : null}
    </>
  );
}

function AddGuard({ onAdded }: { onAdded: () => void }) {
  const [form, setForm] = useState({
    employeeNumber: '',
    displayName: '',
    phone: '+92',
    preferredLocale: 'ur',
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api('/guards', { method: 'POST', body: { ...form, phone: form.phone.replace(/[\s-]/g, '') } });
      setMessage({ kind: 'success', text: `${form.displayName} added.` });
      setForm({ employeeNumber: '', displayName: '', phone: '+92', preferredLocale: form.preferredLocale });
      onAdded();
    } catch (e) {
      setMessage({ kind: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  return (
    <form className="card" onSubmit={(e) => void submit(e)}>
      <h2>Add a guard</h2>
      {message ? <div className={`banner ${message.kind}`}>{message.text}</div> : null}
      <div className="form-row">
        <label className="field">
          <span>Employee number</span>
          <input required value={form.employeeNumber} onChange={set('employeeNumber')} />
        </label>
        <label className="field">
          <span>Name</span>
          <input required value={form.displayName} onChange={set('displayName')} />
        </label>
      </div>
      <div className="form-row">
        <label className="field">
          <span>Phone (E.164)</span>
          <input required value={form.phone} onChange={set('phone')} inputMode="tel" />
        </label>
        <label className="field">
          <span>App language</span>
          <select value={form.preferredLocale} onChange={set('preferredLocale')}>
            <option value="ur">اردو (Urdu)</option>
            <option value="en">English</option>
          </select>
        </label>
      </div>
      <button className="btn primary" disabled={busy}>
        {busy ? 'Adding…' : 'Add guard'}
      </button>
    </form>
  );
}

type ImportResult = {
  preview: boolean;
  total: number;
  valid: number;
  created: number;
  errors: { row: number; field: string; issue: string }[];
};

function ImportGuards({ onImported }: { onImported: () => void }) {
  const [csv, setCsv] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(preview: boolean) {
    if (!csv) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<ImportResult>(`/guards/import?preview=${preview}`, {
        method: 'POST',
        body: { csv },
      });
      setResult(r);
      if (!preview && r.created > 0) onImported();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Import from CSV</h2>
      <p className="muted">
        Columns: <span className="mono">employee_number, display_name, phone, preferred_locale</span> (en or
        ur). Every row is checked first; nothing is created unless all rows are valid. Up to 5,000 rows.
      </p>
      {error ? <div className="banner error">{error}</div> : null}
      <input
        type="file"
        accept=".csv,text/csv"
        aria-label="CSV file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          setResult(null);
          if (!file) return;
          if (file.size > 1_000_000) {
            setError('The file is larger than 1 MB.');
            return;
          }
          setName(file.name);
          void file.text().then(setCsv);
        }}
      />
      {csv ? (
        <div className="row">
          <button className="btn" disabled={busy} onClick={() => void run(true)}>
            Check {name}
          </button>
          {result?.preview && result.errors.length === 0 && result.valid > 0 ? (
            <button className="btn primary" disabled={busy} onClick={() => void run(false)}>
              Import {result.valid} guards
            </button>
          ) : null}
        </div>
      ) : null}
      {result ? (
        <div className={`banner ${result.errors.length ? 'error' : 'success'}`}>
          {result.preview
            ? `${result.valid} of ${result.total} rows are valid.`
            : `${result.created} guards imported.`}
          {result.errors.length > 0 ? (
            <ul>
              {result.errors.slice(0, 20).map((e) => (
                <li key={`${e.row}-${e.field}-${e.issue}`}>
                  Row {e.row}, {e.field}: {e.issue}
                </li>
              ))}
              {result.errors.length > 20 ? <li>…and {result.errors.length - 20} more</li> : null}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function GuardDialog(props: {
  guard: Guard;
  timezone: string;
  onClose: () => void;
  onChanged: (g: Guard) => void;
}) {
  const { guard, timezone, onClose, onChanged } = props;
  const { can } = useSession();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [code, setCode] = useState<Code | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDevices = useCallback(async () => {
    if (!can('devices.read')) return;
    try {
      setDevices((await api<{ devices: Device[] }>(`/guards/${guard.id}/devices`)).devices);
    } catch (e) {
      setError(errorText(e));
    }
  }, [can, guard.id]);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  async function act(run: () => Promise<Guard | void>) {
    setError(null);
    try {
      const result = await run();
      if (result) onChanged(result);
      await loadDevices();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="guard-title" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <h2 id="guard-title">{guard.displayName}</h2>
          <button className="btn small ghost" onClick={onClose}>
            Close
          </button>
        </div>
        {error ? <div className="banner error">{error}</div> : null}
        <dl className="kv">
          <dt>Employee number</dt>
          <dd className="mono">{guard.employeeNumber}</dd>
          <dt>Phone</dt>
          <dd className="mono">{guard.phone}</dd>
          <dt>Status</dt>
          <dd>{guard.status.toLowerCase()}</dd>
          <dt>App language</dt>
          <dd>{guard.preferredLocale === 'ur' ? 'Urdu' : 'English'}</dd>
        </dl>

        {code ? (
          <div className="card" style={{ justifyItems: 'center', textAlign: 'center' }}>
            <span className="label">
              {code.purpose === 'NEW_DEVICE' ? 'New phone code' : 'Enrollment code'}
            </span>
            <QrCode value={code.qrPayload} label={`Enrollment QR code for ${guard.displayName}`} />
            <div className="mono" style={{ fontSize: 24, letterSpacing: '0.12em' }}>
              {code.code}
            </div>
            <p className="muted">
              Give this to {guard.displayName} in person. In the SENTRY app they scan the QR code or type the
              code, then enter their phone number {guard.phone}. It works once and expires{' '}
              {formatDateTime(code.expiresAt, timezone)}. It is shown only now.
            </p>
          </div>
        ) : null}

        <div className="row">
          {can('devices.enroll') && guard.status === 'ACTIVE' ? (
            <button
              className="btn primary"
              onClick={() =>
                void act(async () =>
                  setCode(await api<Code>(`/guards/${guard.id}/enrollment-codes`, { method: 'POST' })),
                )
              }
            >
              {guard.enrolled ? 'Move to a new phone' : 'Enroll phone'}
            </button>
          ) : null}
          {can('guards.write') && guard.status === 'ACTIVE' ? (
            <button
              className="btn"
              onClick={() =>
                void act(() =>
                  api<Guard>(`/guards/${guard.id}`, {
                    method: 'PATCH',
                    body: { status: 'SUSPENDED', version: guard.version },
                  }),
                )
              }
            >
              Suspend
            </button>
          ) : null}
          {can('guards.write') && guard.status !== 'ACTIVE' && guard.status !== 'TERMINATED' ? (
            <button
              className="btn"
              onClick={() =>
                void act(() =>
                  api<Guard>(`/guards/${guard.id}`, {
                    method: 'PATCH',
                    body: { status: 'ACTIVE', version: guard.version },
                  }),
                )
              }
            >
              Reactivate
            </button>
          ) : null}
          {can('guards.write') && guard.status !== 'TERMINATED' ? (
            <button
              className="btn danger"
              onClick={() => {
                if (
                  window.confirm(
                    `Terminate ${guard.displayName}? Their phone is signed out and the record is kept.`,
                  )
                ) {
                  void act(() => api<Guard>(`/guards/${guard.id}/terminate`, { method: 'POST' }));
                }
              }}
            >
              Terminate
            </button>
          ) : null}
        </div>

        {devices ? (
          <div className="grid">
            <h3>Phones</h3>
            {devices.length === 0 ? (
              <div className="empty">No phone enrolled yet.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Phone</th>
                      <th>App</th>
                      <th>Status</th>
                      <th>Last seen</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {devices.map((d) => (
                      <tr key={d.id}>
                        <td>{[d.manufacturer, d.model].filter(Boolean).join(' ') || d.platform}</td>
                        <td className="mono muted">{d.appVersion ?? '—'}</td>
                        <td>
                          <span className={`badge ${d.status === 'ACTIVE' ? 'ok' : 'danger'}`}>
                            {d.status === 'ACTIVE' ? 'active' : (d.revokedReason ?? 'revoked').toLowerCase()}
                          </span>
                        </td>
                        <td className="muted">
                          {d.lastSeenAt ? formatDateTime(d.lastSeenAt, timezone) : '—'}
                        </td>
                        <td>
                          {d.status === 'ACTIVE' && can('devices.revoke') ? (
                            <button
                              className="btn small danger"
                              onClick={() => {
                                if (
                                  window.confirm(
                                    'Sign this phone out? The guard needs a new code to use the app again.',
                                  )
                                ) {
                                  void act(() =>
                                    api(`/devices/${d.id}/revoke`, {
                                      method: 'POST',
                                      body: { reason: 'LOST' },
                                    }).then(() => undefined),
                                  );
                                }
                              }}
                            >
                              Revoke
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
