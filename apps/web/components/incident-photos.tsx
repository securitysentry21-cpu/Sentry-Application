'use client';

// An incident's photos (PROD §10.3, ARCH §12, D-18). Each shows through a 5-minute signed link to
// its view copy, re-encoded without metadata (GET /attachments/:id/url); a link that has expired is
// asked for again before the photo opens. Every photo says whether it came from the camera or the
// gallery; refused ones say why. Owners and Administrators can download the original, kept as
// evidence; each download is recorded in the audit log (incidents.attachments.original).
import type { IncidentAttachment } from '@sentryops/contracts';
import { useEffect, useState } from 'react';

import { api, errorText } from '../lib/api';
import { zonedDateTime } from '../lib/format';
import { PHOTO_STATUS_LABEL, rejectionText, SOURCE_LABEL } from '../lib/incidents';

type SignedLink = { url: string; expiresAt: string };

/** A signed link from the API is a web address; anything else is never put in the page. */
const webUrl = (url: string) => /^https?:\/\//i.test(url);

const SOURCE_BADGE: Record<IncidentAttachment['captureSource'], string> = {
  IN_APP_CAMERA: 'plain',
  GALLERY: 'warn',
};

/** The photos as tiles. Plain, so tests can render them. */
export function PhotoTiles({
  attachments,
  links,
  timeZone,
  onOpen,
}: {
  attachments: readonly IncidentAttachment[];
  links: Readonly<Record<string, SignedLink>>;
  timeZone: string;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="photo-grid">
      {attachments.map((a, i) => {
        const link = links[a.id];
        const label = `Photo ${i + 1} (${SOURCE_LABEL[a.captureSource]})`;
        return (
          <figure className="photo" key={a.id}>
            {a.status === 'AVAILABLE' && link ? (
              <button
                type="button"
                className="photo-thumb"
                onClick={() => onOpen(a.id)}
                aria-label={`Open ${label}`}
              >
                <img src={link.url} alt={label} loading="lazy" referrerPolicy="no-referrer" />
              </button>
            ) : (
              <div className="photo-thumb empty-photo">
                {a.status === 'AVAILABLE' ? 'Loading…' : PHOTO_STATUS_LABEL[a.status]}
              </div>
            )}
            <figcaption>
              <span className={`badge ${SOURCE_BADGE[a.captureSource]}`}>
                {SOURCE_LABEL[a.captureSource]}
              </span>
              {a.status === 'REJECTED' ? <div>Refused: {rejectionText(a.rejectionReason)}</div> : null}
              {a.exifCapturedAt ? (
                <div className="faint">Taken {zonedDateTime(a.exifCapturedAt, timeZone)}</div>
              ) : null}
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}

export function IncidentPhotos({
  attachments,
  timeZone,
  canOriginal,
}: {
  attachments: readonly IncidentAttachment[];
  timeZone: string;
  canOriginal: boolean;
}) {
  const [links, setLinks] = useState<Record<string, SignedLink>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const available = attachments.filter((a) => a.status === 'AVAILABLE').map((a) => a.id);
  const key = available.join(' ');

  const fetchLink = async (id: string): Promise<SignedLink> => {
    const link = await api<SignedLink>(`/attachments/${id}/url`);
    if (!webUrl(link.url)) throw new Error('not a web link');
    setLinks((current) => ({ ...current, [id]: link }));
    return link;
  };

  useEffect(() => {
    let cancelled = false;
    for (const id of key ? key.split(' ') : []) {
      void api<SignedLink>(`/attachments/${id}/url`)
        .then((link) => {
          if (!cancelled && webUrl(link.url)) setLinks((current) => ({ ...current, [id]: link }));
        })
        .catch((e: unknown) => !cancelled && setError(errorText(e)));
    }
    return () => {
      cancelled = true;
    };
  }, [key]);

  const show = async (id: string) => {
    setError(null);
    const link = links[id];
    try {
      if (!link || Date.parse(link.expiresAt) <= Date.now() + 5_000) await fetchLink(id);
      setOpen(id);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const downloadOriginal = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const link = await api<SignedLink>(`/attachments/${id}/original-url`);
      if (!webUrl(link.url)) throw new Error('not a web link');
      // Served as a download: the page stays where it is.
      window.location.assign(link.url);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const current = open ? attachments.find((a) => a.id === open) : undefined;
  const currentLink = open ? links[open] : undefined;
  const index = current ? attachments.indexOf(current) + 1 : 0;

  return (
    <>
      {error ? <div className="banner error">{error}</div> : null}
      <PhotoTiles
        attachments={attachments}
        links={links}
        timeZone={timeZone}
        onOpen={(id) => void show(id)}
      />
      {current && currentLink ? (
        <div
          className="overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Photo ${index}`}
          onClick={() => setOpen(null)}
        >
          <div className="dialog wide" onClick={(e) => e.stopPropagation()}>
            <div className="card-head">
              <h2>
                Photo {index}{' '}
                <span className={`badge ${SOURCE_BADGE[current.captureSource]}`}>
                  {SOURCE_LABEL[current.captureSource]}
                </span>
              </h2>
              <button type="button" className="btn small ghost" onClick={() => setOpen(null)}>
                Close
              </button>
            </div>
            <img
              className="photo-full"
              src={currentLink.url}
              alt={`Photo ${index} (${SOURCE_LABEL[current.captureSource]})`}
              referrerPolicy="no-referrer"
            />
            <p className="faint">
              A copy with the photo’s metadata removed.
              {current.width && current.height ? ` ${current.width} × ${current.height} px.` : ''}
              {current.exifCapturedAt ? ` Taken ${zonedDateTime(current.exifCapturedAt, timeZone)}.` : ''}
            </p>
            {canOriginal ? (
              <div className="row">
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void downloadOriginal(current.id)}
                >
                  {busy ? 'Preparing…' : 'Download original'}
                </button>
                <span className="faint">Downloading the original is recorded in the audit log.</span>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
