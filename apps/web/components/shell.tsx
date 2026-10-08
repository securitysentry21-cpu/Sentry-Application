'use client';

// The authenticated frame: navigation, organization switcher, and who is signed in — on every
// screen, because control-room PCs are shared (SEC §5).
import type { Permission } from '@sentryops/contracts';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { ROLE_LABELS } from '../lib/format';
import { SignOutButton, useSession } from '../lib/session';

type NavItem = { href: string; label: string; permission?: Permission };

const OPERATIONS: NavItem[] = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/live', label: 'Live map', permission: 'live.read' },
  { href: '/shifts', label: 'Shifts', permission: 'shifts.read' },
  { href: '/guards', label: 'Guards', permission: 'guards.read' },
  { href: '/sites', label: 'Sites', permission: 'sites.read' },
];

const ADMINISTRATION: NavItem[] = [
  { href: '/members', label: 'Members', permission: 'members.manage' },
  { href: '/settings', label: 'Settings', permission: 'org.settings.read' },
  { href: '/audit', label: 'Audit log', permission: 'audit.read' },
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
  '/live',
]);

export function AppShell({ children }: { children: ReactNode }) {
  const session = useSession();
  const pathname = usePathname();
  const visible = (items: NavItem[]) =>
    items.filter((i) => BUILT.has(i.href) && (!i.permission || session.can(i.permission)));

  const link = (item: NavItem) => (
    <Link key={item.href} href={item.href} aria-current={pathname.startsWith(item.href) ? 'page' : undefined}>
      {item.label}
    </Link>
  );

  const admin = visible(ADMINISTRATION);
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Image src="/brand/sentry-wordmark-on-dark.png" alt="SENTRY" width={2172} height={724} priority />
        </div>
        <nav className="nav" aria-label="Main">
          <div className="section">Operations</div>
          {visible(OPERATIONS).map(link)}
          {admin.length > 0 ? <div className="section">Administration</div> : null}
          {admin.map(link)}
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
        <main className="content">{children}</main>
      </div>
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
