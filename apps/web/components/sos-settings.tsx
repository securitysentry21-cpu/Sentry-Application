// The SOS settings (PROD §11.4, Appendix B) as a form an Owner can read: the escalation ladder (who
// gets a dashboard push and a text, and when, while an SOS is not acknowledged), the emergency
// contacts texted at the ladder's last step, the number the guard app's "Call supervisor" dials, and
// whether SOS texts carry the guard's position. The form checks what the server will check; the
// server decides. Everyone else in Settings sees the same in words. The dashboard alarm itself is
// not a setting: it sounds on every connected dashboard from the first second until acknowledged.
import type { Role } from '@sentryops/contracts';

import { ROLE_LABELS } from '../lib/format';
import {
  afterText,
  contactsProblems,
  LADDER,
  LADDER_ROLES,
  ladderProblems,
  MAX_EMERGENCY_CONTACTS,
  normalizePhone,
  SETTING_PHONE,
  type Ladder,
  type LadderStep,
} from '../lib/sos';

export const ESCALATION = 'sos.escalation';
export const CONTACTS = 'sos.emergency_contacts';
export const CALL_NUMBER = 'sos.emergency_call_number';
export const COORDINATES = 'sos.sms_include_coordinates';
/** The SOS settings this form edits; any other sos.* key is shown as it is. */
export const SOS_FORM_KEYS: ReadonlySet<string> = new Set([ESCALATION, CONTACTS, CALL_NUMBER, COORDINATES]);

const roles = (value: unknown): Role[] =>
  Array.isArray(value) ? value.filter((r): r is Role => typeof r === 'string') : [];

/** The stored ladder, read defensively: anything malformed becomes the empty ladder the form flags. */
export function readLadder(value: unknown): Ladder {
  const v = (value ?? {}) as { steps?: unknown; repeatEverySeconds?: unknown };
  const steps = Array.isArray(v.steps) ? v.steps : [];
  return {
    steps: steps.map((raw) => {
      const s = (raw ?? {}) as Record<string, unknown>;
      return {
        atSeconds: typeof s.atSeconds === 'number' ? s.atSeconds : Number.NaN,
        dashboardAlarm: s.dashboardAlarm !== false,
        webPushTo: roles(s.webPushTo),
        smsTo: roles(s.smsTo),
        smsEmergencyContacts: s.smsEmergencyContacts === true,
      };
    }),
    repeatEverySeconds: typeof v.repeatEverySeconds === 'number' ? v.repeatEverySeconds : Number.NaN,
  };
}

const readList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];

/** The value the server gets for one of this form's keys, from what the form holds. */
export function sosChange(key: string, draft: unknown): unknown {
  if (key === CONTACTS) return readList(draft).map(normalizePhone).filter(Boolean);
  if (key === CALL_NUMBER) return normalizePhone(typeof draft === 'string' ? draft : '') || null;
  return draft;
}

/** What the server would refuse in this form's changes, in words; empty when it is fine. */
export function sosProblems(draft: Readonly<Record<string, unknown>>): string[] {
  const problems: string[] = [];
  if (ESCALATION in draft) problems.push(...ladderProblems(readLadder(draft[ESCALATION])));
  if (CONTACTS in draft) problems.push(...contactsProblems(sosChange(CONTACTS, draft[CONTACTS]) as string[]));
  if (CALL_NUMBER in draft) {
    const number = sosChange(CALL_NUMBER, draft[CALL_NUMBER]);
    if (typeof number === 'string' && !SETTING_PHONE.test(number))
      problems.push('The emergency call number is not a full international number (like +923001234567).');
  }
  return problems;
}

const roleList = (list: readonly Role[]) =>
  list.length === 0 ? 'nobody' : list.map((r) => ROLE_LABELS[r] ?? r).join(', ');

/** One step in words: "At once: dashboard push to Supervisors…; text to Supervisors". */
export function stepWords(step: LadderStep): string {
  const parts = [`dashboard push to ${roleList(step.webPushTo)}`, `text to ${roleList(step.smsTo)}`];
  if (step.smsEmergencyContacts) parts.push('text to the emergency contacts');
  const when = afterText(step.atSeconds);
  return `${when.charAt(0).toUpperCase()}${when.slice(1)}: ${parts.join('; ')}`;
}

type Props = {
  readonly settings: Readonly<Record<string, unknown>>;
  readonly editable: ReadonlySet<string>;
  readonly draft: Readonly<Record<string, unknown>>;
  readonly onChange: (key: string, value: unknown) => void;
};

export function SosSettings({ settings, editable, draft, onChange }: Props) {
  const value = (key: string) => (key in draft ? draft[key] : settings[key]);
  const ladder = readLadder(value(ESCALATION));
  const contacts = readList(value(CONTACTS));
  const callNumber = value(CALL_NUMBER);
  const coordinates = value(COORDINATES) === true;
  const problems = sosProblems(draft);

  return (
    <div className="grid">
      <section className="grid">
        <h3>Escalation while an SOS is not acknowledged</h3>
        <p className="muted">
          The alarm sounds on every connected dashboard from the first second until someone acknowledges.
          Acknowledging stops the steps below.
        </p>
        {editable.has(ESCALATION) ? (
          <LadderEditor ladder={ladder} onChange={(next) => onChange(ESCALATION, next)} />
        ) : (
          <ul className="plain-list">
            {ladder.steps.map((s, i) => (
              <li key={i}>{stepWords(s)}</li>
            ))}
            <li>
              Then every {ladder.repeatEverySeconds} seconds: again, to everyone reached so far, until
              acknowledged.
            </li>
          </ul>
        )}
      </section>

      <section className="grid">
        <h3>Emergency contacts</h3>
        <p className="muted">
          People outside the dashboard, texted at the steps marked “emergency contacts”. Never texted for a
          drill. Up to {MAX_EMERGENCY_CONTACTS}.
        </p>
        {editable.has(CONTACTS) ? (
          <div className="grid">
            {contacts.map((c, i) => (
              <div className="row" key={i}>
                <input
                  type="tel"
                  inputMode="tel"
                  autoComplete="off"
                  placeholder="+923001234567"
                  aria-label={`Emergency contact ${i + 1}`}
                  value={c}
                  onChange={(e) =>
                    onChange(
                      CONTACTS,
                      contacts.map((x, j) => (j === i ? e.target.value : x)),
                    )
                  }
                />
                <button
                  type="button"
                  className="btn small ghost"
                  onClick={() =>
                    onChange(
                      CONTACTS,
                      contacts.filter((_, j) => j !== i),
                    )
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <div className="row">
              <button
                type="button"
                className="btn small"
                disabled={contacts.length >= MAX_EMERGENCY_CONTACTS}
                onClick={() => onChange(CONTACTS, [...contacts, ''])}
              >
                Add a number
              </button>
            </div>
          </div>
        ) : (
          <p>{contacts.length > 0 ? contacts.join(', ') : 'None'}</p>
        )}
      </section>

      <section className="grid">
        <h3>“Call supervisor” number</h3>
        <p className="muted">
          The number the guard app dials when an SOS can&apos;t reach the server (PROD §11.7). Leave it empty
          for none.
        </p>
        {editable.has(CALL_NUMBER) ? (
          <input
            type="tel"
            inputMode="tel"
            autoComplete="off"
            placeholder="+923001234567"
            aria-label="Emergency call number"
            value={typeof callNumber === 'string' ? callNumber : ''}
            onChange={(e) => onChange(CALL_NUMBER, e.target.value)}
          />
        ) : (
          <p>{typeof callNumber === 'string' && callNumber ? callNumber : 'None'}</p>
        )}
      </section>

      <section className="grid">
        <h3>The guard&apos;s position in SOS texts</h3>
        {editable.has(COORDINATES) ? (
          <label className="row">
            <input
              type="checkbox"
              checked={coordinates}
              onChange={(e) => onChange(COORDINATES, e.target.checked)}
            />
            Include the position (coordinates) in SOS text messages
          </label>
        ) : (
          <p>{coordinates ? 'Included' : 'Not included'}</p>
        )}
        <p className="faint">
          Off by default: a text can be read on a locked phone (PROD §13). The text always carries a link that
          needs sign-in.
        </p>
      </section>

      {problems.length > 0 ? (
        <div className="banner error" role="alert">
          <strong>Fix these before saving:</strong>
          <ul className="plain-list">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function RoleChecks({
  label,
  value,
  onChange,
}: {
  label: string;
  value: readonly Role[];
  onChange: (next: Role[]) => void;
}) {
  return (
    <fieldset className="role-checks">
      <legend className="sr-only">{label}</legend>
      {LADDER_ROLES.map((role) => (
        <label className="row" key={role}>
          <input
            type="checkbox"
            checked={value.includes(role)}
            onChange={(e) => onChange(e.target.checked ? [...value, role] : value.filter((r) => r !== role))}
          />
          {ROLE_LABELS[role]}
        </label>
      ))}
    </fieldset>
  );
}

function LadderEditor({ ladder, onChange }: { ladder: Ladder; onChange: (next: Ladder) => void }) {
  const setStep = (i: number, change: Partial<LadderStep>) =>
    onChange({ ...ladder, steps: ladder.steps.map((s, j) => (j === i ? { ...s, ...change } : s)) });
  const last = ladder.steps.at(-1);
  return (
    <div className="grid">
      <div className="table-wrap">
        <table className="ladder">
          <thead>
            <tr>
              <th>Step</th>
              <th>When (seconds unacknowledged)</th>
              <th>Dashboard push to</th>
              <th>Text to</th>
              <th>Emergency contacts</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {ladder.steps.map((s, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>
                  {i === 0 ? (
                    'at once (0)'
                  ) : (
                    <input
                      type="number"
                      min={1}
                      max={LADDER.maxAtSeconds}
                      step={1}
                      aria-label={`Seconds before step ${i + 1}`}
                      value={Number.isNaN(s.atSeconds) ? '' : s.atSeconds}
                      onChange={(e) =>
                        setStep(i, { atSeconds: e.target.value === '' ? Number.NaN : Number(e.target.value) })
                      }
                    />
                  )}
                </td>
                <td>
                  <RoleChecks
                    label={`Dashboard push at step ${i + 1}`}
                    value={s.webPushTo}
                    onChange={(webPushTo) => setStep(i, { webPushTo })}
                  />
                </td>
                <td>
                  <RoleChecks
                    label={`Texts at step ${i + 1}`}
                    value={s.smsTo}
                    onChange={(smsTo) => setStep(i, { smsTo })}
                  />
                </td>
                <td>
                  <label className="row">
                    <input
                      type="checkbox"
                      checked={s.smsEmergencyContacts}
                      onChange={(e) => setStep(i, { smsEmergencyContacts: e.target.checked })}
                    />
                    Text them
                  </label>
                </td>
                <td>
                  {i > 0 ? (
                    <button
                      type="button"
                      className="btn small ghost"
                      onClick={() => onChange({ ...ladder, steps: ladder.steps.filter((_, j) => j !== i) })}
                    >
                      Remove
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row">
        <button
          type="button"
          className="btn small"
          disabled={ladder.steps.length >= LADDER.maxSteps}
          onClick={() =>
            onChange({
              ...ladder,
              steps: [
                ...ladder.steps,
                {
                  atSeconds: Math.min(
                    LADDER.maxAtSeconds,
                    (Number.isNaN(last?.atSeconds ?? 0) ? 0 : (last?.atSeconds ?? 0)) + 60,
                  ),
                  dashboardAlarm: true,
                  webPushTo: [],
                  smsTo: [],
                  smsEmergencyContacts: false,
                },
              ],
            })
          }
        >
          Add a step
        </button>
      </div>
      <label className="field">
        <span>Then repeat every (seconds), to everyone reached so far, until acknowledged</span>
        <input
          type="number"
          min={LADDER.minRepeatS}
          max={LADDER.maxRepeatS}
          step={1}
          value={Number.isNaN(ladder.repeatEverySeconds) ? '' : ladder.repeatEverySeconds}
          onChange={(e) =>
            onChange({
              ...ladder,
              repeatEverySeconds: e.target.value === '' ? Number.NaN : Number(e.target.value),
            })
          }
        />
      </label>
    </div>
  );
}
