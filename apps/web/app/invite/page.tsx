'use client';

// Accepting an invitation. The token arrives in the URL fragment (never sent to a server), is kept
// in this tab's sessionStorage across the sign-in round trip, and is sent once in a POST body.
import Image from 'next/image';
import { useEffect, useState } from 'react';

import { api, errorText } from '../../lib/api';
import { goToSignIn } from '../../lib/session';

const KEY = 'sentry.invitation';

function takeToken(): string | null {
  const match = /token=([A-Za-z0-9_-]{20,100})/.exec(window.location.hash);
  if (match?.[1]) {
    try {
      window.sessionStorage.setItem(KEY, match[1]);
    } catch {
      // fall through: the token stays in the address bar for this visit
    }
    // Drop the token from the address bar and history.
    window.history.replaceState(null, '', '/invite');
    return match[1];
  }
  try {
    return window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export default function InvitePage() {
  const [token, setToken] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [result, setResult] = useState<{ organizationName: string; role: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setToken(takeToken());
    void api<{ signedIn: boolean }>('/auth/session', { organization: null })
      .then((s) => setSignedIn(s.signedIn))
      .catch(() => setMessage('Cannot reach the server.'));
  }, []);

  async function accept() {
    if (!token) return;
    setBusy(true);
    setMessage(null);
    try {
      const accepted = await api<{ organizationName: string; role: string }>('/invitations/accept', {
        method: 'POST',
        body: { token },
        organization: null,
      });
      try {
        window.sessionStorage.removeItem(KEY);
      } catch {
        // nothing stored
      }
      setResult(accepted);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-page">
      <div className="auth-card">
        <Image
          className="wordmark"
          src="/brand/sentry-wordmark-on-dark.png"
          alt="SENTRY"
          width={2172}
          height={724}
          priority
        />
        <h1>Invitation</h1>
        {message ? <div className="banner error">{message}</div> : null}
        {result ? (
          <>
            <div className="banner success">
              You joined <strong>{result.organizationName}</strong>.
            </div>
            <a className="btn primary" href="/dashboard">
              Open the dashboard
            </a>
          </>
        ) : !token ? (
          <p className="muted">This link is incomplete. Open the invitation link you received again.</p>
        ) : signedIn === false ? (
          <>
            <p className="muted">
              Sign in with the email address the invitation was sent to, then come back here.
            </p>
            <button className="btn primary" onClick={goToSignIn}>
              Sign in to accept
            </button>
          </>
        ) : signedIn ? (
          <>
            <p className="muted">
              Accept the invitation to join the organization with the role it was sent with.
            </p>
            <button className="btn primary" disabled={busy} onClick={() => void accept()}>
              {busy ? 'Accepting…' : 'Accept invitation'}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
