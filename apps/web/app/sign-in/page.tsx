'use client';

// Sign-in (D-01). In production the button goes to the organization's identity provider; the
// password never reaches SENTRY (SEC §5). Development builds offer an email-only sign-in instead.
import Image from 'next/image';
import { useEffect, useState, type FormEvent } from 'react';

import { api, errorText } from '../../lib/api';

const ERRORS: Record<string, string> = {
  expired: 'The sign-in took too long or was already used. Please try again.',
  failed: 'Sign-in could not be verified. Please try again.',
  cancelled: 'Sign-in was cancelled.',
  'no-email': 'Your account has no verified email address. Contact your administrator.',
  disabled: 'This account is disabled. Contact your administrator.',
};

/** Only local paths: the same rule the API applies. */
function safeReturnTo(value: string | null): string {
  return value && /^\/([^/\\].*)?$/.test(value) ? value : '/dashboard';
}

export default function SignInPage() {
  const [devAuth, setDevAuth] = useState<boolean | null>(null);
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [returnTo, setReturnTo] = useState('/dashboard');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const target = safeReturnTo(params.get('returnTo'));
    setReturnTo(target);
    const error = params.get('error');
    if (error) setMessage(ERRORS[error] ?? ERRORS.failed ?? null);
    void api<{ signedIn: boolean; devAuth: boolean }>('/auth/session', { organization: null })
      .then((s) => {
        if (s.signedIn && !error) window.location.replace(target);
        else setDevAuth(s.devAuth);
      })
      .catch(() => setMessage('Cannot reach the server.'));
  }, []);

  async function devSignIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api('/auth/dev-login', { method: 'POST', body: { email }, organization: null });
      window.location.replace(returnTo);
    } catch (error) {
      setMessage(errorText(error));
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
        <div>
          <h1>Sign in</h1>
          <p className="muted">Operations dashboard for your security team.</p>
        </div>
        {message ? <div className="banner error">{message}</div> : null}
        {devAuth === null ? null : devAuth ? (
          <form className="grid" onSubmit={(e) => void devSignIn(e)}>
            <div className="banner warn">
              Development sign-in: no password. Production uses your organization&apos;s identity provider
              with two-factor authentication.
            </div>
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <button className="btn primary" disabled={busy || email.length === 0}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        ) : (
          <a className="btn primary" href={`/api/v1/auth/login?returnTo=${encodeURIComponent(returnTo)}`}>
            Sign in
          </a>
        )}
      </div>
    </div>
  );
}
