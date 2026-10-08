'use client';

// Members and invitations. The server enforces every rule (self-change, owner-only roles, last
// owner); the page only offers what the role could do and shows the server's answer when it refuses.
import type { Invitation, Member, StaffRole } from '@sentryops/contracts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { PageHead } from '../../../components/shell';
import { CopyBox } from '../../../components/ui';
import { api, errorText } from '../../../lib/api';
import { formatDateTime, ROLE_LABELS } from '../../../lib/format';
import { useSession } from '../../../lib/session';

const STATUS_BADGE: Record<string, string> = {
  ACTIVE: 'ok',
  DISABLED: 'warn',
  INVITED: 'info',
  REMOVED: 'danger',
};
const INVITE_BADGE: Record<string, string> = {
  PENDING: 'info',
  ACCEPTED: 'ok',
  REVOKED: 'danger',
  EXPIRED: 'warn',
};

export default function MembersPage() {
  const { me, membership, can } = useSession();
  const tz = membership.organizationTimezone;
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);

  const roles: StaffRole[] = can('owners.manage')
    ? ['OWNER', 'ADMIN', 'SUPERVISOR', 'DISPATCHER']
    : ['SUPERVISOR', 'DISPATCHER'];

  const load = useCallback(async () => {
    try {
      const [m, i] = await Promise.all([
        api<{ members: Member[] }>('/members'),
        api<{ invitations: Invitation[] }>('/invitations'),
      ]);
      setMembers(m.members);
      setInvitations(i.invitations);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, membership.organizationId]);

  async function change(
    member: Member,
    body: { role?: StaffRole; status?: 'ACTIVE' | 'DISABLED' | 'REMOVED' },
  ) {
    if (
      body.status === 'REMOVED' &&
      !window.confirm(`Remove ${member.name} from ${membership.organizationName}?`)
    )
      return;
    try {
      await api(`/members/${member.id}`, { method: 'PATCH', body: { ...body, version: member.version } });
      await load();
    } catch (e) {
      setError(errorText(e));
      await load();
    }
  }

  return (
    <>
      <PageHead
        title="Members"
        description="People who use the dashboard. Guards are managed on the Guards page."
      />
      {error ? <div className="banner error">{error}</div> : null}

      <InviteForm
        roles={roles}
        onInvited={(email, url) => {
          setLink({ email, url });
          void load();
        }}
      />

      {link ? (
        <div className="card">
          <div className="card-head">
            <h2>Invitation link for {link.email}</h2>
            <button className="btn small ghost" onClick={() => setLink(null)}>
              Done
            </button>
          </div>
          <p className="muted">
            Send this link to {link.email} yourself (for example by WhatsApp or email). It works once, only
            for that email address, and expires in 7 days. It is shown only now.
          </p>
          <CopyBox value={link.url} />
        </div>
      ) : null}

      <div className="card">
        <h2>Members</h2>
        {members === null ? (
          <div className="loading">Loading…</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const self = m.userId === me.user.id;
                  const privileged = m.role === 'OWNER' || m.role === 'ADMIN';
                  const editable = !self && (!privileged || can('owners.manage'));
                  return (
                    <tr key={m.id}>
                      <td>
                        {m.name} {self ? <span className="faint">(you)</span> : null}
                      </td>
                      <td className="muted">{m.email}</td>
                      <td>
                        {editable ? (
                          <select
                            value={m.role}
                            aria-label={`Role of ${m.name}`}
                            onChange={(e) => void change(m, { role: e.target.value as StaffRole })}
                          >
                            {[...new Set([m.role as StaffRole, ...roles])].map((r) => (
                              <option key={r} value={r}>
                                {ROLE_LABELS[r]}
                              </option>
                            ))}
                          </select>
                        ) : (
                          ROLE_LABELS[m.role]
                        )}
                      </td>
                      <td>
                        <span className={`badge ${STATUS_BADGE[m.status] ?? ''}`}>
                          {m.status.toLowerCase()}
                        </span>
                      </td>
                      <td>
                        {editable ? (
                          <div className="row">
                            {m.status === 'ACTIVE' ? (
                              <button
                                className="btn small"
                                onClick={() => void change(m, { status: 'DISABLED' })}
                              >
                                Disable
                              </button>
                            ) : (
                              <button
                                className="btn small"
                                onClick={() => void change(m, { status: 'ACTIVE' })}
                              >
                                Enable
                              </button>
                            )}
                            <button
                              className="btn small danger"
                              onClick={() => void change(m, { status: 'REMOVED' })}
                            >
                              Remove
                            </button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Invitations</h2>
        {invitations.length === 0 ? (
          <div className="empty">No invitations yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Expires</th>
                  <th>Invited by</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {invitations.map((i) => (
                  <tr key={i.id}>
                    <td>{i.email}</td>
                    <td>{ROLE_LABELS[i.role]}</td>
                    <td>
                      <span className={`badge ${INVITE_BADGE[i.status] ?? ''}`}>
                        {i.status.toLowerCase()}
                      </span>
                    </td>
                    <td className="muted">{formatDateTime(i.expiresAt, tz)}</td>
                    <td className="muted">{i.createdByName ?? 'Operator'}</td>
                    <td>
                      {i.status === 'PENDING' &&
                      (can('owners.manage') || !['OWNER', 'ADMIN'].includes(i.role)) ? (
                        <button
                          className="btn small danger"
                          onClick={() =>
                            void api(`/invitations/${i.id}/revoke`, { method: 'POST' })
                              .then(load)
                              .catch((e: unknown) => setError(errorText(e)))
                          }
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
    </>
  );
}

function InviteForm({
  roles,
  onInvited,
}: {
  roles: StaffRole[];
  onInvited: (email: string, url: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<StaffRole>(
    roles.includes('SUPERVISOR') ? 'SUPERVISOR' : (roles[0] ?? 'DISPATCHER'),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ acceptUrl: string }>('/invitations', { method: 'POST', body: { email, role } });
      onInvited(email, res.acceptUrl);
      setEmail('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={(e) => void submit(e)}>
      <h2>Invite someone</h2>
      {error ? <div className="banner error">{error}</div> : null}
      <div className="form-row">
        <label className="field">
          <span>Email</span>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as StaffRole)}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <button className="btn primary" disabled={busy || !email}>
          {busy ? 'Creating…' : 'Create invitation'}
        </button>
      </div>
    </form>
  );
}
