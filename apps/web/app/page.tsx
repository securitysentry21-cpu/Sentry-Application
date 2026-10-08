import { ROLES } from '@sentryops/contracts';
import Image from 'next/image';

export default function Home() {
  return (
    <main>
      <div className="stack">
        <Image
          className="wordmark"
          src="/brand/sentry-wordmark-on-dark.png"
          alt="SENTRY"
          width={2172}
          height={724}
          priority
        />
        <span className="label">Operations dashboard</span>
        <p className="note">
          Phase 0 skeleton — no features yet. Shared contracts loaded: {ROLES.length} roles.
        </p>
      </div>
    </main>
  );
}
