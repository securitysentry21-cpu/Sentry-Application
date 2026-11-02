'use client';

// Organization settings. Only the keys the server lists as editable get inputs; the server
// validates ranges and cross-field rules (PROD §8.3) and returns the reasons when it refuses. The SOS
// settings have their own form (escalation ladder, emergency contacts, "Call supervisor" number,
// coordinates in texts), checked here before saving the way the server will check them. Each member
// sets up their own device under Settings, Notifications.
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { PageHead } from '../../../components/shell';
import { SOS_FORM_KEYS, SosSettings, sosChange, sosProblems } from '../../../components/sos-settings';
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
  const [draft, setDraft] = useState<Record<string, unknown>>({});
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
  const problems = sosProblems(draft);

  function changes(): { values: Record<string, unknown>; problems: string[] } {
    const values: Record<string, unknown> = {};
    const invalid: string[] = [];
    for (const [key, raw] of Object.entries(draft)) {
      const current = data?.settings[key];
      if (SOS_FORM_KEYS.has(key)) values[key] = sosChange(key, raw);
      else if (typeof current === 'number') values[key] = Number(raw);
      else if (typeof current === 'boolean') values[key] = raw === true;
      else if (Array.isArray(current))
        values[key] = String(raw)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      else if (current !== null && typeof current === 'object') {
        // Other structured settings are edited as JSON text.
        try {
          values[key] = JSON.parse(String(raw)) as unknown;
        } catch {
          invalid.push(`${key} is not valid JSON.`);
        }
      } else values[key] = raw === '' ? null : raw;
    }
    return { values, problems: invalid };
  }

  async function save() {
    if (!data) return;
    const { values, problems: invalid } = changes();
    if (invalid.length > 0 || problems.length > 0) {
      setMessage({ kind: 'error', text: [...invalid, ...problems].join(' ') });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await api('/settings', { method: 'PATCH', body: { changes: values, version: data.version } });
      setMessage({ kind: 'success', text: 'Settings saved.' });
      await load();
    } catch (e) {
      setMessage({ kind: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const setValue = (key: string, value: unknown) => setDraft((d) => ({ ...d, [key]: value }));

  return (
    <>
      <PageHead
        title="Settings"
        description="Thresholds for this organization. Values not editable here are set by the platform operator."
        actions={
          <>
            <Link className="btn" href="/settings/notifications">
              Notifications on this device
            </Link>
            {editable.size > 0 ? (
              <button
                className="btn primary"
                disabled={busy || Object.keys(draft).length === 0 || problems.length > 0}
                onClick={() => void save()}
              >
                {busy ? 'Saving…' : 'Save changes'}
              </button>
            ) : null}
          </>
        }
      />
      {message ? <div className={`banner ${message.kind}`}>{message.text}</div> : null}
      <div className="grid cols-2">
        {[...groups.entries()].map(([group, keys]) => {
          const others = group === 'sos' ? keys.filter((k) => !SOS_FORM_KEYS.has(k)) : keys;
          return (
            <div className={`card${group === 'sos' ? ' wide-card' : ''}`} key={group}>
              <h2>{GROUPS[group] ?? group}</h2>
              {group === 'sos' ? (
                <SosSettings settings={data.settings} editable={editable} draft={draft} onChange={setValue} />
              ) : null}
              {others.length > 0 ? (
                <dl className="kv">
                  {others.map((key) => {
                    const value = data.settings[key];
                    const name = key.slice(group.length + 1).replaceAll('_', ' ');
                    return (
                      <SettingRow
                        key={key}
                        name={name}
                        value={value}
                        editable={editable.has(key)}
                        // Only the SOS form keeps other kinds of value in the draft.
                        draft={draft[key] as string | boolean | undefined}
                        onChange={(v) => setValue(key, v)}
                      />
                    );
                  })}
                </dl>
              ) : null}
            </div>
          );
        })}
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
  else if (value !== null && typeof value === 'object' && !Array.isArray(value))
    control = (
      <textarea
        className="mono"
        rows={6}
        aria-label={name}
        value={draft === undefined ? JSON.stringify(value, null, 2) : String(draft)}
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
