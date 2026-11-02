// Checking an uploaded photo (ARCH §12 step 5, SEC §12): the real type from its first bytes (never
// the name or the declared type), its pixel count before anything is decoded (a decompression bomb
// is refused, not unpacked), then a re-encoded JPEG view copy with every bit of metadata dropped.
// The phone always uploads JPEG; PNG and WebP decode too; HEIC is recognised but can't be decoded
// here (the image library ships without HEVC), so it is refused as unreadable.
import sharp, { type Metadata } from 'sharp';

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic';

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

/** The type the bytes say, or null for anything that isn't one of the allowed images. */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  const at = (i: number) => bytes[i] ?? -1;
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => at(i) === b)) return 'image/png';
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 12 && ascii(4, 8) === 'ftyp' && HEIF_BRANDS.has(ascii(8, 12))) return 'image/heic';
  return null;
}

export type ProcessedImage =
  | {
      readonly ok: true;
      readonly type: ImageType;
      readonly width: number;
      readonly height: number;
      readonly view: Buffer;
      readonly exif: ExifFacts;
    }
  | { readonly ok: false; readonly reason: 'TYPE_NOT_ALLOWED' | 'TOO_MANY_PIXELS' | 'UNREADABLE' };

/** The view copy: long edge at most 2,048 px, JPEG, no metadata (sharp writes none unless asked). */
const VIEW_EDGE_PX = 2048;
const VIEW_QUALITY = 82;

export async function processImage(original: Buffer, maxPixels: number): Promise<ProcessedImage> {
  const type = sniffImageType(original.subarray(0, 32));
  if (!type) return { ok: false, reason: 'TYPE_NOT_ALLOWED' };
  if (type === 'image/heic') return { ok: false, reason: 'UNREADABLE' };
  let meta: Metadata;
  try {
    // Reads the header only: dimensions are known before a single pixel is decoded.
    meta = await sharp(original, { failOn: 'error' }).metadata();
  } catch {
    return { ok: false, reason: 'UNREADABLE' };
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width <= 0 || height <= 0) return { ok: false, reason: 'UNREADABLE' };
  if (width * height > maxPixels) return { ok: false, reason: 'TOO_MANY_PIXELS' };
  const format = meta.format;
  const expected = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' }[type];
  if (format !== expected) return { ok: false, reason: 'TYPE_NOT_ALLOWED' };
  try {
    const view = await sharp(original, { failOn: 'error', limitInputPixels: maxPixels, sequentialRead: true })
      .rotate()
      .resize({ width: VIEW_EDGE_PX, height: VIEW_EDGE_PX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: VIEW_QUALITY })
      .toBuffer();
    return { ok: true, type, width, height, view, exif: meta.exif ? readExif(meta.exif) : NO_EXIF };
  } catch {
    return { ok: false, reason: 'UNREADABLE' };
  }
}

// ── EXIF: capture time and GPS only ───────────────────────────────────────────────────────────

export type ExifFacts = {
  /** "YYYY:MM:DD HH:MM:SS" as written, and its offset when the camera wrote one ("+05:00"). */
  readonly capturedLocal: string | null;
  readonly offset: string | null;
  readonly gps: { readonly lat: number; readonly lng: number } | null;
};

const NO_EXIF: ExifFacts = { capturedLocal: null, offset: null, gps: null };

/**
 * Reads DateTimeOriginal, OffsetTimeOriginal and the GPS position from an EXIF block ("Exif\0\0"
 * then TIFF). Every offset is bounds-checked; anything malformed reads as absent, never throws.
 */
export function readExif(block: Buffer): ExifFacts {
  try {
    const tiff = block.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? block.subarray(6) : block;
    if (tiff.length < 8) return NO_EXIF;
    const little = tiff.toString('latin1', 0, 2) === 'II';
    if (!little && tiff.toString('latin1', 0, 2) !== 'MM') return NO_EXIF;
    const u16 = (o: number) =>
      o + 2 <= tiff.length ? (little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o)) : -1;
    const u32 = (o: number) =>
      o + 4 <= tiff.length ? (little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o)) : -1;
    if (u16(2) !== 42) return NO_EXIF;

    type Entry = { tag: number; type: number; count: number; valueOffset: number; inline: number };
    const ifd = (offset: number): Entry[] => {
      const n = u16(offset);
      if (n < 0 || n > 512) return [];
      const entries: Entry[] = [];
      for (let i = 0; i < n; i++) {
        const o = offset + 2 + i * 12;
        if (o + 12 > tiff.length) break;
        entries.push({
          tag: u16(o),
          type: u16(o + 2),
          count: u32(o + 4),
          valueOffset: u32(o + 8),
          inline: o + 8,
        });
      }
      return entries;
    };
    const ascii = (e: Entry | undefined): string | null => {
      if (!e || e.type !== 2 || e.count < 1 || e.count > 64) return null;
      const start = e.count <= 4 ? e.inline : e.valueOffset;
      if (start < 0 || start + e.count > tiff.length) return null;
      return tiff.toString('latin1', start, start + e.count).replace(/\0.*$/, '');
    };
    const rationals = (e: Entry | undefined, n: number): number[] | null => {
      if (!e || e.type !== 5 || e.count !== n) return null;
      const start = e.valueOffset;
      if (start < 0 || start + n * 8 > tiff.length) return null;
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        const num = u32(start + i * 8);
        const den = u32(start + i * 8 + 4);
        if (den <= 0) return null;
        out.push(num / den);
      }
      return out;
    };
    const find = (entries: Entry[], tag: number) => entries.find((e) => e.tag === tag);

    const root = ifd(u32(4));
    const exifIfd = find(root, 0x8769);
    const exifEntries = exifIfd ? ifd(exifIfd.valueOffset) : [];
    const captured = ascii(find(exifEntries, 0x9003));
    const offset = ascii(find(exifEntries, 0x9011));

    let gps: ExifFacts['gps'] = null;
    const gpsIfd = find(root, 0x8825);
    if (gpsIfd) {
      const g = ifd(gpsIfd.valueOffset);
      const latRef = ascii(find(g, 1));
      const lat = rationals(find(g, 2), 3);
      const lngRef = ascii(find(g, 3));
      const lng = rationals(find(g, 4), 3);
      if (lat && lng && latRef && lngRef) {
        const deg = (v: number[]) => (v[0] ?? 0) + (v[1] ?? 0) / 60 + (v[2] ?? 0) / 3600;
        const la = deg(lat) * (latRef.startsWith('S') ? -1 : 1);
        const lo = deg(lng) * (lngRef.startsWith('W') ? -1 : 1);
        if (Math.abs(la) <= 90 && Math.abs(lo) <= 180) gps = { lat: la, lng: lo };
      }
    }
    return {
      capturedLocal: captured && /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(captured) ? captured : null,
      offset: offset && /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : null,
      gps,
    };
  } catch {
    return NO_EXIF;
  }
}
