'use client';

// Organization settings. Only the keys the server lists as editable get inputs; the server
// validates ranges and cross-field rules (PROD §8.3) and returns the reasons when it refuses.
import { useCallback, useEffect, useMemo, useState } from 'react';

import { PageHead } from '../../../components/shell';
import { api, errorText } from '../../../lib/api';
import { useSession } from '../../../lib/session';

type SettingsBody = { settings: Record<string, unknown>; editableKeys: string[]; version: number };

const GROUPS: Record<string, string> = {
  shift: 'Shifts',
  tracking: 'Tracking',
  sync: 'Sync',
  freshness: 'Tracking health',
  geofence: 'Geofence',
  checkpoint: 'Checkpoints',
  patrol: 'Patrols',
  alerts: 'Alerts',
  sos: 'SOS',
  privacy: 'Privacy',
  retention: 'Retention',
  notifications: 'Notifications',
  exports: 'Exports',
};

function display(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? '—' : value.map(String).join(', ');
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string')
    return String(value);
  return '—';
}

export default function SettingsPage() {
  const { membership } = useSession();
  const [data, setData] = useState<SettingsBody | null>(null);
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<SettingsBody>('/settings'));
      setDraft({});
    } catch (e) {
      setMessage({ kind: 'error', text: errorText(e) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, membership.organizationId]);

  const groups = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const key of Object.keys(data?.settings ?? {}).sort()) {
      const group = key.split('.')[0] ?? key;
      out.set(group, [...(out.get(group) ?? []), key]);
    }
    return out;
  }, [data]);

  if (!data) return <div className="loading">Loading…</div>;
  const editable = new Set(data.editableKeys);

  function changes(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(draft)) {
      const current = data?.settings[key];
      if (typeof current === 'number') out[key] = Number(raw);
      else if (typeof current === 'boolean') out[key] = raw === true;
      else if (Array.isArray(current))
        out[key] = String(raw)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      else out[key] = raw === '' ? null : raw;
    }
    return out;
  }

  async function save() {
    if (!data) return;
    setBusy(true);
    setMessage(null);
    try {
      await api('/settings', { method: 'PATCH', body: { changes: changes(), version: data.version } });
      setMessage({ kind: 'success', text: 'Settings saved.' });
      await load();
    } catch (e) {
      setMessage({ kind: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead
        title="Settings"
        description="Thresholds for this organization. Values not editable here are set by the platform operator."
        actions={
          editable.size > 0 ? (
            <button
              className="btn primary"
              disabled={busy || Object.keys(draft).length === 0}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          ) : null
        }
      />
      {message ? <div className={`banner ${message.kind}`}>{message.text}</div> : null}
      <div className="grid cols-2">
        {[...groups.entries()].map(([group, keys]) => (
          <div className="card" key={group}>
            <h2>{GROUPS[group] ?? group}</h2>
            <dl className="kv">
              {keys.map((key) => {
                const value = data.settings[key];
                const name = key.slice(group.length + 1).replaceAll('_', ' ');
                return (
                  <SettingRow
                    key={key}
                    name={name}
                    value={value}
                    editable={editable.has(key)}
                    draft={draft[key]}
                    onChange={(v) => setDraft((d) => ({ ...d, [key]: v }))}
                  />
                );
              })}
            </dl>
          </div>
        ))}
      </div>
    </>
  );
}

function SettingRow(props: {
  name: string;
  value: unknown;
  editable: boolean;
  draft: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
}) {
  const { name, value, editable, draft, onChange } = props;
  let control;
  if (!editable) control = <span className="muted">{display(value)}</span>;
  else if (typeof value === 'boolean')
    control = (
      <input
        type="checkbox"
        checked={draft === undefined ? value : draft === true}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  else if (typeof value === 'number')
    control = (
      <input
        type="number"
        value={draft === undefined ? String(value) : String(draft)}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  else
    control = (
      <input
        type="text"
        value={
          draft === undefined
            ? Array.isArray(value)
              ? value.join(', ')
              : display(value).replace('—', '')
            : String(draft)
        }
        onChange={(e) => onChange(e.target.value)}
      />
    );
  return (
    <>
      <dt>{name}</dt>
      <dd>{control}</dd>
    </>
  );
}
