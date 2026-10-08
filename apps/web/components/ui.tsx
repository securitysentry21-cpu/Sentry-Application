'use client';

import { useState } from 'react';

/** A read-only value with a copy button, for links and codes shown once. */
export function CopyBox({ value, label = 'Link' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-box">
      <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} aria-label={label} />
      <button
        className="btn"
        type="button"
        onClick={() =>
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          })
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
