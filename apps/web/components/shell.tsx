'use client';

// The authenticated frame: navigation, organization switcher, and who is signed in — on every
// screen, because control-room PCs are shared (SEC §5). The SOS alarm and its sound warning live
// here too, so they appear whatever page is open (PROD §11.6).
//
// Navigation is a rail of icons. Each one carries its page's name for screen readers and shows it as
// a tooltip on hover or focus; the rail widens to show every name, a choice this browser remembers.
// On a phone the same navigation opens as a drawer from the menu button.
import type { Permission } from '@sentryops/contracts';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode } from 'react';

import { EXPORTS_PAGE_PERMISSIONS } from '../lib/exports';
import { ROLE_LABELS } from '../lib/format';
import { useLive } from '../lib/live';
import { SignOutButton, useSession } from '../lib/session';
import { AlarmLayer } from './alarm';
import { Icon, type IconName } from './icons';

/** PROD §14.7: say so when live updates have been down for more than 10 s. */
const DISCONNECTED_BANNER_MS = 10_000;
/** Where this browser remembers whether the rail shows the pages' names. */
const NAMES_KEY = 'sentry.nav.names';
/** The width below which navigation is a drawer (app/globals.css uses the same). */
const PHONE_QUERY = '(max-width: 860px)';

type NavItem = {
  href: string;
  label: string;
  icon: IconName;
  permission?: Permission;
  /** Shown with any one of these. */
  anyOf?: readonly Permission[];
};

const OPERATIONS: NavItem[] = [
  { href: '/dashboard', label: 'Overview', icon: 'overview' },
  { href: '/live', label: 'Live map', icon: 'live', permission: 'live.read' },
  { href: '/alerts', label: 'Alerts', icon: 'alerts', permission: 'alerts.read' },
  { href: '/incidents', label: 'Incidents', icon: 'incidents', permission: 'incidents.read' },
  { href: '/shifts', label: 'Shifts', icon: 'shifts', permission: 'shifts.read' },
  { href: '/patrols', label: 'Patrols', icon: 'patrols', permission: 'patrols.read' },
  { href: '/guards', label: 'Guards', icon: 'guards', permission: 'guards.read' },
  { href: '/sites', label: 'Sites', icon: 'sites', permission: 'sites.read' },
  { href: '/reports', label: 'Reports', icon: 'reports', permission: 'reports.read' },
  { href: '/exports', label: 'Exports', icon: 'exports', anyOf: EXPORTS_PAGE_PERMISSIONS },
];

const ADMINISTRATION: NavItem[] = [
  { href: '/members', label: 'Members', icon: 'members', permission: 'members.manage' },
  { href: '/settings', label: 'Settings', icon: 'settings', permission: 'org.settings.read' },
  { href: '/drills', label: 'SOS drills', icon: 'drills', permission: 'sos.drill' },
  { href: '/audit', label: 'Audit log', icon: 'audit', permission: 'audit.read' },
];

/** Every member's own, whatever their role: how alarms reach this device (PROD §11.5). */
const THIS_DEVICE: NavItem[] = [
  {
    href: '/settings/notifications',
    label: 'Notifications',
    icon: 'notifications',
    permission: 'alerts.read',
  },
];

/** Pages that exist so far; later phases add theirs here. */
const BUILT = new Set([
  '/dashboard',
  '/members',
  '/settings',
  '/audit',
  '/guards',
  '/sites',
  '/shifts',
  '/patrols',
  '/live',
  '/alerts',
  '/reports',
  '/exports',
  '/incidents',
  '/drills',
  '/settings/notifications',
]);

function readNamesShown(): boolean {
  try {
    return window.localStorage.getItem(NAMES_KEY) === 'shown';
  } catch {
    return false;
  }
}

function rememberNamesShown(shown: boolean): void {
  try {
    window.localStorage.setItem(NAMES_KEY, shown ? 'shown' : 'hidden');
  } catch {
    // Private windows may refuse storage; the rail then starts narrow next time.
  }
}

function isPhone(): boolean {
  try {
    return window.matchMedia(PHONE_QUERY).matches;
  } catch {
    return false;
  }
}

/** "Demo Owner" → "DO": the avatar beside the name, never instead of it. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const ends = words.length > 1 ? [words[0]!, words[words.length - 1]!] : words;
  return (
    ends
      .map((w) => Array.from(w)[0] ?? '')
      .join('')
      .toUpperCase() || '?'
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const session = useSession();
  const pathname = usePathname();
  const [namesShown, setNamesShown] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [tip, setTip] = useState<{ label: string; top: number } | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => setNamesShown(readNamesShown()), []);
  // Following a link closes the drawer and any tooltip.
  useEffect(() => {
    setDrawer(false);
    setTip(null);
  }, [pathname]);
  useEffect(() => {
    if (drawer) toggleRef.current?.focus();
  }, [drawer]);

  const visible = (items: NavItem[]) =>
    items.filter(
      (i) =>
        BUILT.has(i.href) &&
        (!i.permission || session.can(i.permission)) &&
        (!i.anyOf || i.anyOf.some((p) => session.can(p))),
    );
  const operations = visible(OPERATIONS);
  const admin = visible(ADMINISTRATION);
  const device = visible(THIS_DEVICE);
  // The most specific entry is the current one: /settings/notifications is not also Settings.
  const current = [...operations, ...admin, ...device]
    .filter((i) => pathname === i.href || pathname.startsWith(`${i.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  const closeDrawer = () => {
    setDrawer(false);
    menuRef.current?.focus();
  };
  const onToggle = () => {
    setTip(null);
    if (isPhone()) {
      closeDrawer();
      return;
    }
    rememberNamesShown(!namesShown);
    setNamesShown(!namesShown);
  };
  // Names show as tooltips only while the rail is narrow; Escape hides one (WCAG 1.4.13).
  const showTip = (label: string, element: HTMLElement) => {
    if (namesShown || drawer) return;
    const box = element.getBoundingClientRect();
    setTip({ label, top: box.top + box.height / 2 });
  };
  const tipProps = (label: string) => ({
    onPointerEnter: (e: PointerEvent<HTMLElement>) => showTip(label, e.currentTarget),
    onPointerLeave: () => setTip(null),
    onFocus: (e: FocusEvent<HTMLElement>) => showTip(label, e.currentTarget),
    onBlur: () => setTip(null),
  });

  const toggleLabel = drawer ? 'Close menu' : namesShown ? 'Hide page names' : 'Show page names';
  const link = (item: NavItem) => (
    <Link
      key={item.href}
      href={item.href}
      aria-current={item.href === current ? 'page' : undefined}
      {...tipProps(item.label)}
    >
      <Icon name={item.icon} />
      <span className="nav-label">{item.label}</span>
    </Link>
  );
  const group = (label: string, items: NavItem[]) =>
    items.length > 0 ? (
      <div className="nav-group" role="group" aria-label={label} key={label}>
        <div className="nav-section" aria-hidden="true">
          {label}
        </div>
        {items.map(link)}
      </div>
    ) : null;

  return (
    <div
      className="shell"
      data-names={namesShown ? 'shown' : 'hidden'}
      data-drawer={drawer ? 'open' : 'closed'}
    >
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside
        className="rail"
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          setTip(null);
          if (drawer) closeDrawer();
        }}
      >
        <button
          ref={toggleRef}
          type="button"
          className="rail-toggle"
          aria-expanded={drawer || namesShown}
          aria-controls="main-nav"
          onClick={onToggle}
          {...tipProps(toggleLabel)}
        >
          <Icon name={drawer ? 'close' : 'panel'} />
          <span className="nav-label">{toggleLabel}</span>
        </button>
        <nav id="main-nav" className="nav" aria-label="Main">
          {group('Operations', operations)}
          {group('Administration', admin)}
          {group('This device', device)}
        </nav>
      </aside>
      {drawer ? <div className="drawer-backdrop" onClick={closeDrawer} aria-hidden="true" /> : null}
      {tip ? (
        <div className="rail-tip" style={{ top: tip.top }} aria-hidden="true">
          {tip.label}
        </div>
      ) : null}
      <div className="frame">
        <header className="topbar">
          <div className="topbar-start">
            <button
              ref={menuRef}
              type="button"
              className="icon-btn menu-btn"
              aria-label="Open menu"
              aria-expanded={drawer}
              aria-controls="main-nav"
              onClick={() => setDrawer(true)}
            >
              <Icon name="menu" />
            </button>
            <Link className="brand" href="/dashboard" aria-label="SENTRY, overview">
              <Image src="/brand/sentry-wordmark-on-dark.png" alt="" width={2172} height={724} priority />
            </Link>
            <span className="topbar-rule" aria-hidden="true" />
            <OrganizationSwitcher />
          </div>
          <div className="topbar-end">
            <LiveStatus />
            <div className="who" title={`Signed in as ${session.me.user.name}`}>
              <span className="avatar" aria-hidden="true">
                {initials(session.me.user.name)}
              </span>
              <span className="who-text">
                <span className="sr-only">Signed in as </span>
                <strong>{session.me.user.name}</strong>
                <span className="who-role">{ROLE_LABELS[session.membership.role]}</span>
              </span>
            </div>
            <SignOutButton className="btn small ghost" />
          </div>
        </header>
        <main className="content" id="main" tabIndex={-1}>
          <AlarmLayer />
          <LiveBanner />
          {children}
        </main>
      </div>
    </div>
  );
}

/** Whether this screen is receiving live updates, in a word as well as a colour (PROD §14.7). */
function LiveStatus() {
  const { can } = useSession();
  const live = useLive();
  if (!can('live.read')) return null;
  const state =
    live.status === 'down' ? 'down' : live.status === 'open' && live.model ? 'live' : 'connecting';
  const words = { live: 'Live', down: 'Reconnecting', connecting: 'Connecting' } as const;
  return <span className={`live-pill ${state}`}>{words[state]}</span>;
}

function LiveBanner() {
  const live = useLive();
  if (!live.model || live.disconnectedMs <= DISCONNECTED_BANNER_MS) return null;
  return (
    <div className="banner warn" role="status">
      <strong>Live updates disconnected</strong> — reconnecting. Times keep counting, but positions and alerts
      may be out of date.
    </div>
  );
}

function OrganizationSwitcher() {
  const { me, membership, switchOrganization } = useSession();
  if (me.memberships.length === 1) {
    return <strong className="org-name">{membership.organizationName}</strong>;
  }
  return (
    <select
      className="org-select"
      value={membership.organizationId}
      onChange={(event) => switchOrganization(event.target.value)}
      aria-label="Organization"
    >
      {me.memberships.map((m) => (
        <option key={m.organizationId} value={m.organizationId}>
          {m.organizationName}
        </option>
      ))}
    </select>
  );
}

export function PageHead({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="page-title">
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="row page-actions">{actions}</div> : null}
    </div>
  );
}
