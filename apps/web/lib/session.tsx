'use client';

// Who is signed in, which organization is selected, and what the role allows. The selection is
// sent as X-Organization-Id on every request; the server validates it against the membership
// (INV-17), so changing it in the browser can't reach another organization.
import type { MeResponse, Permission } from '@sentryops/contracts';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { api, ApiError, onSignedOut, setApiOrganization } from './api';

type Membership = MeResponse['memberships'][number];

type Session = {
  readonly me: MeResponse;
  readonly membership: Membership;
  readonly switchOrganization: (id: string) => void;
  readonly can: (permission: Permission) => boolean;
  readonly reload: () => Promise<void>;
};

const SessionContext = createContext<Session | null>(null);
const STORAGE_KEY = 'sentry.organization';

function readStoredOrganization(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeOrganization(id: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // private mode: the choice lasts for this page only
  }
}

export function goToSignIn(): void {
  const here = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/sign-in?returnTo=${encodeURIComponent(here)}`);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'signed-out' | 'error'>('loading');

  const load = useCallback(async () => {
    try {
      const data = await api<MeResponse>('/me', { organization: null });
      const stored = readStoredOrganization();
      const pick = data.memberships.find((m) => m.organizationId === stored) ?? data.memberships[0] ?? null;
      setApiOrganization(pick?.organizationId ?? null);
      setSelected(pick?.organizationId ?? null);
      setMe(data);
      setState('ready');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) goToSignIn();
      else setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => onSignedOut(() => setState((s) => (s === 'ready' ? 'signed-out' : s))), []);

  const switchOrganization = useCallback((id: string) => {
    storeOrganization(id);
    setApiOrganization(id);
    setSelected(id);
  }, []);

  const membership = me?.memberships.find((m) => m.organizationId === selected) ?? null;
  const session = useMemo<Session | null>(() => {
    if (!me || !membership) return null;
    const permissions = new Set<string>(membership.permissions);
    return {
      me,
      membership,
      switchOrganization,
      can: (permission) => permissions.has(permission),
      reload: load,
    };
  }, [me, membership, switchOrganization, load]);

  if (state === 'loading') return <div className="loading">Loading…</div>;
  if (state === 'error') {
    return (
      <div className="center-page">
        <div className="auth-card">
          <h1>Cannot reach SENTRY</h1>
          <p className="muted">The server did not answer. Check the connection and try again.</p>
          <button className="btn primary" onClick={() => void load()}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (me && me.memberships.length === 0) return <NoOrganization me={me} />;
  if (!session) return <div className="loading">Loading…</div>;

  return (
    <SessionContext.Provider value={session}>
      {children}
      {state === 'signed-out' ? <SignedOutOverlay /> : null}
    </SessionContext.Provider>
  );
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession outside SessionProvider');
  return session;
}

/** Blocking: a control-room screen must never keep showing data after the session ended. */
function SignedOutOverlay() {
  return (
    <div className="overlay" role="alertdialog" aria-modal="true" aria-labelledby="signed-out-title">
      <div className="dialog">
        <h2 id="signed-out-title">You have been signed out</h2>
        <p className="muted">
          Your session ended or your access changed. Nothing on this screen is current any more. Sign in again
          to continue.
        </p>
        <button className="btn primary" onClick={goToSignIn}>
          Sign in again
        </button>
      </div>
    </div>
  );
}

function NoOrganization({ me }: { me: MeResponse }) {
  return (
    <div className="center-page">
      <div className="auth-card">
        <h1>No organization yet</h1>
        <p className="muted">
          You are signed in as <strong>{me.user.email ?? me.user.name}</strong>, but you are not a member of
          any organization. Ask an administrator for an invitation link.
        </p>
        <SignOutButton />
      </div>
    </div>
  );
}

export function SignOutButton({ className = 'btn' }: { className?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void api('/auth/logout', { method: 'POST', organization: null })
          .catch(() => undefined)
          .finally(() => window.location.assign('/sign-in'));
      }}
    >
      Sign out
    </button>
  );
}
