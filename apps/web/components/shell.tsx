'use client';

// The authenticated frame: navigation, organization switcher, and who is signed in — on every
// screen, because control-room PCs are shared (SEC §5). The SOS alarm and its sound warning live
// here too, so they appear whatever page is open (PROD §11.6).
import type { Permission } from '@sentryops/contracts';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { ROLE_LABELS } from '../lib/format';
import { useLive } from '../lib/live';
import { SignOutButton, useSession } from '../lib/session';
import { AlarmLayer } from './alarm';

/** PROD §14.7: say so when live updates have been down for more than 10 s. */
const DISCONNECTED_BANNER_MS = 10_000;

type NavItem = { href: string; label: string; permission?: Permission };

const OPERATIONS: NavItem[] = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/live', label: 'Live map', permission: 'live.read' },
  { href: '/alerts', label: 'Alerts', permission: 'alerts.read' },
  { href: '/incidents', label: 'Incidents', permission: 'incidents.read' },
  { href: '/shifts', label: 'Shifts', permission: 'shifts.read' },
  { href: '/patrols', label: 'Patrols', permission: 'patrols.read' },
  { href: '/guards', label: 'Guards', permission: 'guards.read' },
  { href: '/sites', label: 'Sites', permission: 'sites.read' },
  { href: '/reports', label: 'Reports', permission: 'reports.read' },
];

const ADMINISTRATION: NavItem[] = [
  { href: '/members', label: 'Members', permission: 'members.manage' },
  { href: '/settings', label: 'Settings', permission: 'org.settings.read' },
  { href: '/drills', label: 'SOS drills', permission: 'sos.drill' },
  { href: '/audit', label: 'Audit log', permission: 'audit.read' },
];

/** Every member's own, whatever their role: how alarms reach this device (PROD §11.5). */
const THIS_DEVICE: NavItem[] = [
  { href: '/settings/notifications', label: 'Notifications', permission: 'alerts.read' },
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
  '/incidents',
  '/drills',
  '/settings/notifications',
]);

export function AppShell({ children }: { children: ReactNode }) {
  const session = useSession();
  const pathname = usePathname();
  const visible = (items: NavItem[]) =>
    items.filter((i) => BUILT.has(i.href) && (!i.permission || session.can(i.permission)));

  const operations = visible(OPERATIONS);
  const admin = visible(ADMINISTRATION);
  const device = visible(THIS_DEVICE);
  // The most specific entry is the current one: /settings/notifications is not also Settings.
  const current = [...operations, ...admin, ...device]
    .filter((i) => pathname === i.href || pathname.startsWith(`${i.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  const link = (item: NavItem) => (
    <Link key={item.href} href={item.href} aria-current={item.href === current ? 'page' : undefined}>
      {item.label}
    </Link>
  );
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Image src="/brand/sentry-wordmark-on-dark.png" alt="SENTRY" width={2172} height={724} priority />
        </div>
        <nav className="nav" aria-label="Main">
          <div className="section">Operations</div>
          {operations.map(link)}
          {admin.length > 0 ? <div className="section">Administration</div> : null}
          {admin.map(link)}
          {device.length > 0 ? <div className="section">This device</div> : null}
          {device.map(link)}
        </nav>
      </aside>
      <div>
        <header className="topbar">
          <OrganizationSwitcher />
          <div className="who">
            <span>
              Signed in as <strong>{session.me.user.name}</strong> · {ROLE_LABELS[session.membership.role]}
            </span>
            <SignOutButton className="btn small" />
          </div>
        </header>
        <main className="content">
          <AlarmLayer />
          <LiveBanner />
          {children}
        </main>
      </div>
    </div>
  );
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
    return <strong>{membership.organizationName}</strong>;
  }
  return (
    <label className="row">
      <span className="faint">Organization</span>
      <select
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
    </label>
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
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </div>
  );
}
