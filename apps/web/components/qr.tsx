'use client';

// QR codes drawn as SVG paths from the module matrix: no HTML injection, no images to fetch.
import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

export function QrCode({ value, size = 180, label }: { value: string; size?: number; label: string }) {
  const { path, count } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        if (qr.isDark(row, col)) d += `M${col + 4},${row + 4}h1v1h-1z`;
      }
    }
    return { path: d, count: n };
  }, [value]);
  const box = count + 8; // a 4-module quiet zone on every side
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${box} ${box}`}
      shapeRendering="crispEdges"
      style={{ background: '#fff', borderRadius: 6 }}
    >
      <path d={path} fill="#000" />
    </svg>
  );
}
