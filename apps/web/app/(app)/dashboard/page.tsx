'use client';

import Link from 'next/link';

import { PageHead } from '../../../components/shell';
import { ROLE_LABELS } from '../../../lib/format';
import { useSession } from '../../../lib/session';

export default function DashboardPage() {
  const { me, membership, can } = useSession();
  return (
    <>
      <PageHead
        title={membership.organizationName}
        description={`Welcome, ${me.user.name}. You are signed in as ${ROLE_LABELS[membership.role] ?? membership.role}.`}
      />
      <div className="grid cols-3">
        <div className="card">
          <span className="label">Organization</span>
          <dl className="kv">
            <dt>Time zone</dt>
            <dd>{membership.organizationTimezone}</dd>
            <dt>Your role</dt>
            <dd>{ROLE_LABELS[membership.role]}</dd>
          </dl>
        </div>
        {can('members.manage') ? (
          <div className="card">
            <span className="label">Team</span>
            <p className="muted">
              Invite supervisors, dispatchers and administrators, and manage their roles.
            </p>
            <Link className="btn" href="/members">
              Manage members
            </Link>
          </div>
        ) : null}
        {can('org.settings.read') ? (
          <div className="card">
            <span className="label">Settings</span>
            <p className="muted">Shift, geofence and alert thresholds for this organization.</p>
            <Link className="btn" href="/settings">
              Open settings
            </Link>
          </div>
        ) : null}
      </div>
    </>
  );
}
