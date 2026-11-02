// The dashboard alarm (PROD §11.4, §11.6, §11.10): it shows without sound, with a visible warning
// (ADV-S09); a drill alarms only the members taking part (ADV-S10); and a dashboard reports the
// alarm on screen only while it is on a visible screen, once per alert (INV-10).
import type { Alert, SosDrill } from '@sentryops/contracts';
import type { AnchorHTMLAttributes } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AlarmBar, AlarmView, SoundWarning } from '../components/alarm';
import {
  alarmDecision,
  alarmNotificationText,
  alarmPath,
  alarmsFor,
  alarmTitles,
  createSeenReporter,
  drillsToCheck,
  SEEN_RETRY_MS,
} from '../lib/alarm';

vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={props.href}>{props.children}</a>,
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({ push: () => undefined }) }));

const T0 = Date.parse('2026-11-02T21:00:00Z');
const iso = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const id = (n: number) => `0190a0d2-7c5e-7000-8000-${String(n).padStart(12, '0')}`;
const AHMED = { id: id(1), displayName: 'Ahmed Khan' };
const BILAL = { id: id(2), displayName: 'Bilal Raza' };
const SITE = { id: id(3), name: 'ABC Warehouse' };
const ME = id(10);
const OTHER = id(11);

function sos(overrides: Partial<Alert> = {}): Alert {
  return {
    id: id(20),
    type: 'SOS_ACTIVATED',
    severity: 'CRITICAL',
    status: 'OPEN',
    summary: 'SOS: Ahmed Khan (ABC Warehouse)',
    guard: AHMED,
    site: SITE,
    shiftId: id(4),
    details: {},
    openedAt: iso(0),
    lastTriggeredAt: iso(0),
    triggerCount: 1,
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    resolutionType: null,
    resolutionNote: null,
    dismissedAt: null,
    dismissReason: null,
    detectedLate: false,
    dismissible: false,
    sosEventId: id(30),
    incidentId: null,
    isDrill: false,
    drillId: null,
    escalationLevel: 0,
    version: 1,
    ...overrides,
  };
}

function drill(overrides: Partial<SosDrill> = {}): SosDrill {
  return {
    id: id(40),
    startedAt: iso(-600),
    endsAt: iso(3000),
    endedAt: null,
    active: true,
    startedBy: { id: id(12), name: 'Sarah Owner' },
    guards: [AHMED],
    members: [{ id: ME, name: 'Me' }],
    note: null,
    ...overrides,
  };
}

const view = (props: Partial<Parameters<typeof AlarmView>[0]> = {}) =>
  renderToStaticMarkup(
    <AlarmView
      alarms={[sos()]}
      sound="off"
      onEnableSound={() => undefined}
      now={new Date(T0 + 40_000)}
      canAcknowledge
      onAcknowledge={() => undefined}
      busy={null}
      error={null}
      {...props}
    />,
  );

describe('the alarm without sound (PROD §11.6, ADV-S09)', () => {
  it('ADV-S09 without sound enabled the dashboard shows a visible warning and the alarm overlay still appears', () => {
    const warning = renderToStaticMarkup(<SoundWarning state="off" onEnable={() => undefined} />);
    expect(warning).toContain('Alarm sound is off');
    expect(warning).toContain('Enable alarm sound</button>');

    const overlay = view();
    expect(overlay).toContain('role="alertdialog"');
    expect(overlay).toContain('SOS alarm');
    expect(overlay).toContain('Ahmed Khan');
    expect(overlay).toContain('ABC Warehouse');
    expect(overlay).toContain('40 s ago');
    expect(overlay).toContain('Acknowledge</button>');
    expect(overlay).toContain('href="/sos/');
    // The warning travels with the overlay, which covers the page's own.
    expect(overlay).toContain('Alarm sound is off');
    expect(overlay).toContain('Enable alarm sound</button>');
  });

  it('ADV-S09 a browser that cannot play sound says so, and still shows the alarm; with sound on there is no warning', () => {
    const unavailable = view({ sound: 'unavailable' });
    expect(unavailable).toContain('can’t play the alarm sound');
    expect(unavailable).toContain('role="alertdialog"');
    const on = view({ sound: 'on' });
    expect(on).toContain('role="alertdialog"');
    expect(on).not.toContain('Alarm sound is off');
    expect(renderToStaticMarkup(<SoundWarning state="on" onEnable={() => undefined} />)).toBe('');
  });

  it('on its own page the alarm is a bar that still says it is not acknowledged and offers to acknowledge', () => {
    const bar = renderToStaticMarkup(
      <AlarmBar
        alarms={[sos({ isDrill: true })]}
        now={new Date(T0 + 40_000)}
        canAcknowledge
        onAcknowledge={() => undefined}
        busy={null}
        error={null}
      />,
    );
    expect(bar).toContain('DRILL · ');
    expect(bar).toContain('SOS alarm');
    expect(bar).toContain('not acknowledged');
    expect(bar).toContain('Acknowledge</button>');
  });

  it('every open critical alert alarms, SOS first; acknowledged ones and lower severities do not', () => {
    const critical = sos({
      id: id(21),
      type: 'INCIDENT_CRITICAL',
      sosEventId: null,
      incidentId: id(31),
      openedAt: iso(-60),
      summary: 'Critical incident INC-000007: Fire (ABC Warehouse)',
    });
    const alarms = alarmsFor(
      [
        critical,
        sos(),
        sos({ id: id(22), status: 'ACKNOWLEDGED' }),
        sos({ id: id(23), type: 'INCIDENT_HIGH', severity: 'HIGH' }),
      ],
      ME,
      [],
    );
    expect(alarms.map((a) => a.id)).toEqual([sos().id, critical.id]);
    expect(alarmPath(sos())).toBe(`/sos/${id(30)}`);
    expect(alarmPath(critical)).toBe(`/incidents/${id(31)}`);
    const html = view({ alarms });
    expect(html).toContain('2 alarms');
    expect(html).toContain('Open incident');
    // A second press shows on the alarm (PROD §11.9).
    expect(view({ alarms: [sos({ triggerCount: 3, lastTriggeredAt: iso(30) })] })).toContain(
      'Pressed again ×2',
    );
  });

  it('the tab title says there is an alarm in both of its flashing states, and a drill says DRILL', () => {
    const [a, b] = alarmTitles([sos()]);
    expect(a).toContain('SOS');
    expect(b).toContain('SOS');
    expect(a).not.toBe(b);
    expect(alarmTitles([sos({ isDrill: true })]).every((t) => t.includes('[DRILL]'))).toBe(true);
    expect(alarmTitles([sos(), sos({ id: id(21) })])[0]).toContain('(2)');
  });

  it('the background notification is lock-screen safe: a short name and the site, never a position', () => {
    expect(alarmNotificationText(sos())).toEqual({
      title: 'SOS — Ahmed K. — ABC Warehouse',
      body: 'Open the dashboard to acknowledge.',
    });
    expect(alarmNotificationText(sos({ isDrill: true, triggerCount: 2 })).title).toBe(
      '[DRILL] SOS — Ahmed K. — ABC Warehouse',
    );
    expect(alarmNotificationText(sos({ site: null })).title).toBe('SOS — Ahmed K. — off shift');
  });
});

describe('drills (PROD §11.10, owner decision 2026-11-02)', () => {
  it('ADV-S10 a drill alarms only the members taking part; everyone else sees it labelled DRILL with no alarm', () => {
    const practice = sos({
      isDrill: true,
      drillId: id(40),
      summary: '[DRILL] SOS: Ahmed Khan (ABC Warehouse)',
    });
    const drills = [drill()];
    expect(alarmDecision(practice, ME, drills)).toBe('ALARM');
    expect(alarmDecision(practice, OTHER, drills)).toBe('NOT_IN_DRILL');
    expect(alarmsFor([practice], OTHER, drills)).toEqual([]);
    // The participant's alarm says DRILL, in words.
    const html = view({ alarms: alarmsFor([practice], ME, drills) });
    expect(html).toContain('DRILL — ');
    expect(html).toContain('>DRILL</span>');
  });

  it('ADV-S10 a drill the dashboard has not looked up stays silent until it knows who takes part, and is asked about once', () => {
    const practice = sos({ isDrill: true, drillId: id(40) });
    expect(alarmDecision(practice, ME, [])).toBe('DRILL_UNKNOWN');
    expect(alarmsFor([practice], ME, [])).toEqual([]);
    expect(
      drillsToCheck([practice, sos({ id: id(21), isDrill: true, drillId: id(40) })], [], new Set()),
    ).toEqual([id(40)]);
    expect(drillsToCheck([practice], [], new Set([id(40)]))).toEqual([]);
    expect(drillsToCheck([practice], [drill()], new Set())).toEqual([]);
  });

  it("ADV-S10 another guard's SOS during a drill is real and alarms everyone; a drill alert is matched by the drill it names", () => {
    const real = sos({ id: id(24), guard: BILAL, isDrill: false });
    expect(alarmDecision(real, OTHER, [drill()])).toBe('ALARM');
    // A drill that has ended still decides for the SOS raised during it, however late the page opens.
    const ended = drill({ endedAt: iso(60), active: false });
    expect(alarmDecision(sos({ isDrill: true, drillId: id(40), openedAt: iso(30) }), ME, [ended])).toBe(
      'ALARM',
    );
    expect(alarmDecision(sos({ isDrill: true, drillId: id(40) }), OTHER, [ended])).toBe('NOT_IN_DRILL');
    // Another drill's alert isn't decided by this one.
    expect(alarmDecision(sos({ isDrill: true, drillId: id(41) }), ME, [drill()])).toBe('DRILL_UNKNOWN');
  });

  it('ADV-S10 in a demo or canary organization every SOS is a drill without a window, and it alarms every member', () => {
    const demo = sos({ isDrill: true, drillId: null });
    expect(alarmDecision(demo, ME, [])).toBe('ALARM');
    expect(alarmDecision(demo, OTHER, [])).toBe('ALARM');
    expect(drillsToCheck([demo], [], new Set())).toEqual([]);
  });
});

describe('display receipts (ARCH §13.1, INV-10)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('INV-10 the alarm posts its display receipt only while it is on a visible screen, once per alert', async () => {
    let visible = false;
    const send = vi.fn(() => Promise.resolve());
    const reporter = createSeenReporter({ visible: () => visible, send });
    // On screen in a hidden tab: nothing is said.
    reporter.show(['a']);
    reporter.visibilityChanged();
    expect(send).not.toHaveBeenCalled();
    // The tab comes forward: reported once.
    visible = true;
    reporter.visibilityChanged();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith('a');
    await Promise.resolve();
    reporter.show(['a']);
    reporter.visibilityChanged();
    expect(send).toHaveBeenCalledTimes(1);
    // A second alarm joins it on screen.
    reporter.show(['a', 'b']);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith('b');
    // Hidden again: a new alarm is not reported until it is seen.
    visible = false;
    reporter.show(['a', 'b', 'c']);
    expect(send).toHaveBeenCalledTimes(2);
    // An alarm no longer on screen is never reported.
    reporter.show(['a', 'b']);
    visible = true;
    reporter.visibilityChanged();
    expect(send).toHaveBeenCalledTimes(2);
    reporter.dispose();
  });

  it('INV-10 a failed display receipt is tried again while the alarm is still on a visible screen, never from a hidden tab', async () => {
    vi.useFakeTimers();
    let visible = true;
    let fail = true;
    const send = vi.fn(() => (fail ? Promise.reject(new Error('offline')) : Promise.resolve()));
    const reporter = createSeenReporter({ visible: () => visible, send });
    reporter.show(['a']);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SEEN_RETRY_MS);
    expect(send).toHaveBeenCalledTimes(2);
    // Hidden when the next try comes round: it waits.
    visible = false;
    await vi.advanceTimersByTimeAsync(SEEN_RETRY_MS);
    expect(send).toHaveBeenCalledTimes(2);
    fail = false;
    visible = true;
    reporter.visibilityChanged();
    expect(send).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(SEEN_RETRY_MS * 3);
    expect(send).toHaveBeenCalledTimes(3);
    reporter.dispose();
  });
});
