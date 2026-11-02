'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A short notice in a corner that goes away by itself ("Your export is ready"). Above the page and
 * its dialogs, below the SOS alarm. Give it a new key to show a new notice.
 */
export function Toast({
  children,
  onClose,
  ms = 10_000,
}: {
  children: ReactNode;
  onClose: () => void;
  ms?: number;
}) {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    const timer = window.setTimeout(() => close.current(), ms);
    return () => window.clearTimeout(timer);
  }, [ms]);
  return (
    <div className="toast" role="status">
      <div>{children}</div>
      <button type="button" className="btn small ghost" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

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
