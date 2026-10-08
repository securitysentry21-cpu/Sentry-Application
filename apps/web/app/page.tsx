'use client';

import { useEffect } from 'react';

import { api } from '../lib/api';

/** Sends the visitor to the dashboard when signed in, otherwise to sign-in. */
export default function Home() {
  useEffect(() => {
    void api<{ signedIn: boolean }>('/auth/session', { organization: null })
      .then((s) => window.location.replace(s.signedIn ? '/dashboard' : '/sign-in'))
      .catch(() => window.location.replace('/sign-in'));
  }, []);
  return <div className="loading">Loading…</div>;
}
