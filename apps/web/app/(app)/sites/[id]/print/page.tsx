'use client';

// The QR label sheet for one site. Opening it is audited on the server (CHECKPOINT_QR_PRINTED)
// before the labels are returned.
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { QrCode } from '../../../../../components/qr';
import { PageHead } from '../../../../../components/shell';
import { api, errorText } from '../../../../../lib/api';

type Sheet = {
  site: { id: string; name: string };
  labels: { checkpointId: string; name: string; qrContent: string; qrVersion: number }[];
};

export default function PrintSheetPage() {
  const params = useParams<{ id: string }>();
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<Sheet>(`/sites/${params.id}/checkpoints/print-sheet`)
      .then(setSheet)
      .catch((e: unknown) => setError(errorText(e)));
  }, [params.id]);

  if (error) return <div className="banner error">{error}</div>;
  if (!sheet) return <div className="loading">Loading…</div>;
  return (
    <>
      <PageHead
        title={`QR labels · ${sheet.site.name}`}
        description="Print and fix each label at its checkpoint. Replacing a label in the dashboard makes the printed one stop working."
        actions={
          <button className="btn primary" onClick={() => window.print()}>
            Print
          </button>
        }
      />
      {sheet.labels.length === 0 ? (
        <div className="empty">This site has no active checkpoints.</div>
      ) : (
        <div className="grid cols-3">
          {sheet.labels.map((l) => (
            <div
              key={l.checkpointId}
              className="card"
              style={{ justifyItems: 'center', textAlign: 'center', breakInside: 'avoid' }}
            >
              <QrCode value={l.qrContent} label={`QR label for ${l.name}`} size={200} />
              <strong>{l.name}</strong>
              <span className="faint">
                {sheet.site.name} · v{l.qrVersion}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
