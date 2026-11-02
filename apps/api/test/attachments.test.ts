// Incident photos (ARCH §12, SEC §12, D-18): the signed upload, the worker's checks, the view copy
// without metadata, the audited original for owners and administrators, and links that can't be
// guessed, altered or reused after they expire.
import { createHash, randomUUID } from 'node:crypto';

import { createKysely, createPool, type Pool } from '@sentryops/db';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readExif } from '../src/attachments/image.ts';
import { attachmentKeys } from '../src/storage/objects.ts';
import { runAttachmentProcessor } from '../src/workers/notifications.ts';
import {
  asOwner,
  asPhone,
  call,
  createGuard,
  enrollPhone,
  errorCode,
  seedOrganization,
  signIn,
  startTestApp,
  type EnrolledPhone,
  type TestApp,
} from './support.ts';

const H = 3_600_000;
const BOOT = 'photo-boot';
const AT_SITE = { lat: 31.4702, lon: 74.4001, accuracyM: 8 };

let t: TestApp;
let sweepPool: Pool;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let admin: string;
let supervisor: string;
let siteId: string;
let seq = 0;
let mono = 9_000_000;

const processPhotos = () => runAttachmentProcessor({ ...t.deps, sweep: createKysely(sweepPool) });
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** An EXIF block with a capture time and a GPS position, the way a phone camera writes one. */
function exifBlock(captured: string, lat: number, lng: number): Buffer {
  // Little-endian TIFF: IFD0 → Exif IFD (DateTimeOriginal) and GPS IFD (refs and DMS rationals).
  const parts: Buffer[] = [];
  const dms = (v: number) => {
    const d = Math.floor(v);
    const m = Math.floor((v - d) * 60);
    const s = Math.round(((v - d) * 60 - m) * 60 * 100);
    return [d, 1, m, 1, s, 100];
  };
  const tiff = Buffer.alloc(400);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  // IFD0 at 8: two entries (ExifIFD pointer, GPS pointer).
  let o = 8;
  tiff.writeUInt16LE(2, o);
  const entry = (at: number, tag: number, type: number, count: number, value: number) => {
    tiff.writeUInt16LE(tag, at);
    tiff.writeUInt16LE(type, at + 2);
    tiff.writeUInt32LE(count, at + 4);
    tiff.writeUInt32LE(value, at + 8);
  };
  const exifAt = 8 + 2 + 2 * 12 + 4; // 38
  const gpsAt = exifAt + 2 + 12 + 4; // 56
  entry(o + 2, 0x8769, 4, 1, exifAt);
  entry(o + 14, 0x8825, 4, 1, gpsAt);
  // Exif IFD: DateTimeOriginal (ASCII, 20 bytes) at 200.
  o = exifAt;
  tiff.writeUInt16LE(1, o);
  entry(o + 2, 0x9003, 2, 20, 200);
  tiff.write(`${captured}\0`, 200, 'latin1');
  // GPS IFD: 4 entries; rationals at 240 and 264.
  o = gpsAt;
  tiff.writeUInt16LE(4, o);
  entry(o + 2, 1, 2, 2, Buffer.from('N\0\0\0', 'latin1').readUInt32LE(0));
  entry(o + 14, 2, 5, 3, 240);
  entry(o + 26, 3, 2, 2, Buffer.from('E\0\0\0', 'latin1').readUInt32LE(0));
  entry(o + 38, 4, 5, 3, 264);
  dms(lat).forEach((v, i) => tiff.writeUInt32LE(v, 240 + i * 4));
  dms(lng).forEach((v, i) => tiff.writeUInt32LE(v, 264 + i * 4));
  parts.push(Buffer.from('Exif\0\0', 'latin1'), tiff);
  return Buffer.concat(parts);
}

/** A JPEG with an APP1 Exif segment right after SOI. */
async function photoWithExif(captured: string, lat: number, lng: number): Promise<Buffer> {
  const jpeg = await sharp({
    create: { width: 640, height: 480, channels: 3, background: { r: 90, g: 120, b: 160 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  const exif = exifBlock(captured, lat, lng);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(exif.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), app1, exif, jpeg.subarray(2)]);
}

async function onShiftWithIncident(): Promise<{ phone: EnrolledPhone; incidentId: string }> {
  const number = `+9230044${String(10_000 + seq++).padStart(5, '0')}`;
  const guardId = await createGuard(t.app, admin, org.id, {
    employeeNumber: `P-${seq}`,
    displayName: 'Photo guard',
    phone: number,
  });
  const phone = await enrollPhone(t.app, admin, org.id, guardId, number);
  const startsAt = new Date(t.clock.now().getTime() + 5 * 60_000);
  const created = await call(t.app, {
    method: 'POST',
    url: '/api/v1/shifts',
    cookie: admin,
    org: org.id,
    body: {
      guardId,
      siteId,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 8 * H).toISOString(),
    },
  });
  const shiftId = created.json<{ id: string }>().id;
  const item = (type: string, fields: Record<string, unknown>) => {
    mono += 100;
    return {
      clientEventId: randomUUID(),
      type,
      recordedAt: t.clock.now().toISOString(),
      monoMs: mono,
      bootId: BOOT,
      ...fields,
    };
  };
  const res = await asPhone(t.app, phone, {
    method: 'POST',
    url: '/api/v1/sync/batch',
    body: {
      batchId: randomUUID(),
      sentAt: t.clock.now().toISOString(),
      sentMonoMs: mono + 1_000,
      bootId: BOOT,
      items: [
        item('SHIFT_START', {
          shiftId,
          fix: { ...AT_SITE, fixAgeS: 2 },
          permission: { location: 'ALWAYS', precise: true },
        }),
        item('INCIDENT', {
          shiftId,
          incident: {
            type: 'PROPERTY_DAMAGE',
            severity: 'MEDIUM',
            description: 'Fence cut',
            occurredAt: t.clock.now().toISOString(),
          },
          fix: { ...AT_SITE, fixAgeS: 1 },
        }),
      ],
    },
  });
  const results = res.json<{ results: { status: string; incident?: { id: string } }[] }>().results;
  expect(results.map((r) => r.status)).toEqual(['ACCEPTED', 'ACCEPTED']);
  return { phone, incidentId: results[1]?.incident?.id ?? '' };
}

type Slot = {
  attachmentId: string;
  status: string;
  upload: { url: string; headers: Record<string, string> } | null;
};

async function slot(
  phone: EnrolledPhone,
  incidentId: string,
  bytes: Buffer,
  overrides: Record<string, unknown> = {},
) {
  return asPhone(t.app, phone, {
    method: 'POST',
    url: `/api/v1/incidents/${incidentId}/attachments`,
    body: {
      clientEventId: randomUUID(),
      contentType: 'image/jpeg',
      sizeBytes: bytes.length,
      captureSource: 'IN_APP_CAMERA',
      ...overrides,
    },
  });
}

/** The PUT the phone makes to the signed link (the local store stands in for S3 here). */
function put(url: string, headers: Record<string, string>, bytes: Buffer) {
  return t.app.inject({ method: 'PUT', url: new URL(url).pathname, headers: { ...headers }, payload: bytes });
}

async function upload(
  phone: EnrolledPhone,
  incidentId: string,
  bytes: Buffer,
  overrides: Record<string, unknown> = {},
) {
  const res = await slot(phone, incidentId, bytes, overrides);
  expect(res.statusCode, res.body).toBe(200);
  const s = res.json<Slot>();
  const stored = await put(s.upload?.url ?? '', s.upload?.headers ?? {}, bytes);
  expect(stored.statusCode, stored.body).toBe(200);
  const done = await asPhone(t.app, phone, {
    method: 'POST',
    url: `/api/v1/attachments/${s.attachmentId}/complete`,
    body: { sha256: sha256(bytes) },
  });
  expect(done.json<{ status: string }>().status).toBe('PROCESSING');
  await processPhotos();
  return s.attachmentId;
}

async function attachment(id: string) {
  const { rows } = await asOwner(t.db, (c) =>
    c.query<{
      status: string;
      rejection_reason: string | null;
      exif_latitude: number | null;
      capture_source: string;
    }>(
      'select status, rejection_reason, exif_latitude, capture_source from incident_attachments where id = $1',
      [id],
    ),
  );
  return rows[0];
}

beforeAll(async () => {
  t = await startTestApp();
  sweepPool = createPool(t.db.urls.system_worker, { max: 2 });
  org = await seedOrganization(t.db, 'Photo Co', [
    { email: 'owner@photo.test', role: 'OWNER' },
    { email: 'admin@photo.test', role: 'ADMIN' },
    { email: 'sup@photo.test', role: 'SUPERVISOR' },
  ]);
  admin = await signIn(t.app, 'admin@photo.test');
  supervisor = await signIn(t.app, 'sup@photo.test');
  const site = await call(t.app, {
    method: 'POST',
    url: '/api/v1/sites',
    cookie: admin,
    org: org.id,
    body: { name: 'Depot', boundary: { kind: 'CIRCLE', center: { lat: 31.47, lng: 74.4 }, radiusM: 300 } },
  });
  siteId = site.json<{ id: string }>().id;
});

afterAll(async () => {
  await sweepPool?.end();
  await t?.close();
});

describe('a photo from upload to view (ARCH §12)', () => {
  it('ADV-F05 the view copy has no metadata; the original is the evidence, for owners and administrators only (audited)', async () => {
    const { phone, incidentId } = await onShiftWithIncident();
    // Taken during the shift (site time, UTC+5): its GPS is kept with the photo (INV-08).
    const local = new Date(t.clock.now().getTime() + 5 * H)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ')
      .replaceAll('-', ':');
    const original = await photoWithExif(local, 31.4703, 74.4002);
    expect(readExif((await sharp(original).metadata()).exif ?? Buffer.alloc(0)).gps).not.toBeNull();
    const id = await upload(phone, incidentId, original, { captureSource: 'GALLERY' });
    expect(await attachment(id)).toMatchObject({ status: 'AVAILABLE', capture_source: 'GALLERY' });
    expect((await attachment(id))?.exif_latitude).toBeCloseTo(31.4703, 3);

    const detail = await call(t.app, {
      method: 'GET',
      url: `/api/v1/incidents/${incidentId}`,
      cookie: supervisor,
      org: org.id,
    });
    expect(
      detail.json<{ incident: { attachments: { id: string; captureSource: string }[] } }>().incident
        .attachments,
    ).toEqual([expect.objectContaining({ id, captureSource: 'GALLERY' })]);
    const link = await call(t.app, {
      method: 'GET',
      url: `/api/v1/attachments/${id}/url`,
      cookie: supervisor,
      org: org.id,
    });
    expect(link.statusCode, link.body).toBe(200);
    const { url, expiresAt } = link.json<{ url: string; expiresAt: string }>();
    expect(Date.parse(expiresAt) - t.clock.now().getTime()).toBeLessThanOrEqual(5 * 60_000);
    const view = await t.app.inject({ method: 'GET', url: new URL(url).pathname });
    expect(view.statusCode).toBe(200);
    expect(view.headers['content-type']).toBe('image/jpeg');
    const viewMeta = await sharp(view.rawPayload).metadata();
    expect(viewMeta.exif).toBeUndefined();
    expect(viewMeta.icc).toBeUndefined();

    // The original: refused to a supervisor; an administrator's download is audited before the link.
    const refused = await call(t.app, {
      method: 'GET',
      url: `/api/v1/attachments/${id}/original-url`,
      cookie: supervisor,
      org: org.id,
    });
    expect(errorCode(refused)).toBe('FORBIDDEN');
    const allowed = await call(t.app, {
      method: 'GET',
      url: `/api/v1/attachments/${id}/original-url`,
      cookie: admin,
      org: org.id,
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
    const audited = await asOwner(t.db, (c) =>
      c.query(
        `select 1 from audit_logs where action = 'ATTACHMENT_ORIGINAL_DOWNLOADED' and resource_id = $1`,
        [id],
      ),
    );
    expect(audited.rowCount).toBe(1);
    const evidence = await t.app.inject({
      method: 'GET',
      url: new URL(allowed.json<{ url: string }>().url).pathname,
    });
    expect(sha256(evidence.rawPayload)).toBe(sha256(original));
    expect(evidence.headers['content-disposition']).toMatch(/^attachment; filename="INC-\d{6}-/);
  });

  it('a gallery photo taken before the shift keeps its time but never its GPS (INV-08)', async () => {
    const { phone, incidentId } = await onShiftWithIncident();
    const original = await photoWithExif('2026:01:01 10:00:00', 33.1, 73.6);
    const id = await upload(phone, incidentId, original, { captureSource: 'GALLERY' });
    expect(await attachment(id)).toMatchObject({ status: 'AVAILABLE', exif_latitude: null });
  });

  it('at most 5 photos per incident; asking again for the same photo gets the same slot', async () => {
    const { phone, incidentId } = await onShiftWithIncident();
    const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#888' } })
      .jpeg()
      .toBuffer();
    const clientEventId = randomUUID();
    const first = await slot(phone, incidentId, bytes, { clientEventId });
    const again = await slot(phone, incidentId, bytes, { clientEventId });
    expect(again.json<Slot>().attachmentId).toBe(first.json<Slot>().attachmentId);
    for (let i = 0; i < 4; i++) expect((await slot(phone, incidentId, bytes)).statusCode).toBe(200);
    const sixth = await slot(phone, incidentId, bytes);
    expect(errorCode(sixth)).toBe('ATTACHMENT_LIMIT_REACHED');
  });
});

describe('what the checks refuse (SEC §12)', () => {
  it('an uploaded original cannot be replaced through its link while the link is still valid: the evidence stays', async () => {
    const { phone, incidentId } = await onShiftWithIncident();
    const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#888' } })
      .jpeg()
      .toBuffer();
    const s = (await slot(phone, incidentId, bytes)).json<Slot>();
    const url = s.upload?.url ?? '';
    const headers = s.upload?.headers ?? {};
    expect(headers['if-none-match']).toBe('*');
    // The condition is part of the link (S3: a signed header): without it the upload is refused.
    const unconditional = Object.fromEntries(
      Object.entries(headers).filter(([name]) => name !== 'if-none-match'),
    );
    expect((await put(url, unconditional, bytes)).statusCode).toBe(404);
    expect((await put(url, headers, bytes)).statusCode).toBe(200);
    // Other bytes of the same length, through the same link, 14 minutes before it expires.
    const altered = Buffer.from(bytes);
    const at = altered.length - 10;
    altered.writeUInt8(altered.readUInt8(at) ^ 0xff, at);
    expect((await put(url, headers, altered)).statusCode).toBe(412);
    const stored = await t.deps.objects.read(
      attachmentKeys(org.id, incidentId, s.attachmentId).original,
      1_000_000,
    );
    expect(stored?.equals(bytes)).toBe(true);
  });

  it('ADV-F01 an executable renamed .jpg is rejected by its bytes', async () => {
    const { phone, incidentId } = await onShiftWithIncident();
    const exe = Buffer.concat([
      Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1'),
      Buffer.alloc(2_000, 0x41),
    ]);
    const id = await upload(phone, incidentId, exe);
    expect(await attachment(id)).toMatchObject({ status: 'REJECTED', rejection_reason: 'TYPE_NOT_ALLOWED' });
    const view = await call(t.app, {
      method: 'GET',
      url: `/api/v1/attachments/${id}/url`,
      cookie: supervisor,
      org: org.id,
    });
    expect(view.statusCode).toBe(404);
  });

  it('ADV-F02 an oversize file is refused, and a decompression bomb is rejected before it is decoded', async () => {
    const { phone, incidentId } = await onShiftWithIncident();
    const tooBig = await slot(phone, incidentId, Buffer.alloc(1), { sizeBytes: 15 * 1024 * 1024 + 1 });
    expect(errorCode(tooBig)).toBe('VALIDATION_FAILED');
    // 7,000 × 7,000 = 49 MP of one colour: a few kilobytes compressed, 49 million pixels decoded.
    const bomb = await sharp({ create: { width: 7000, height: 7000, channels: 3, background: '#000' } })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const id = await upload(phone, incidentId, bomb, { contentType: 'image/png' });
    expect(await attachment(id)).toMatchObject({ status: 'REJECTED', rejection_reason: 'TOO_MANY_PIXELS' });
    // The upload link holds the declared length: a larger body is refused at the door.
    const s = (await slot(phone, incidentId, Buffer.alloc(100))).json<Slot>();
    expect(
      (
        await put(
          s.upload?.url ?? '',
          { ...(s.upload?.headers ?? {}), 'content-length': '200' },
          Buffer.alloc(200),
        )
      ).statusCode,
    ).toBe(404);
  });

  it('a hash that does not match the upload is rejected', async () => {
    const { phone, incidentId } = await onShiftWithIncident();
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#555' } })
      .jpeg()
      .toBuffer();
    const s = (await slot(phone, incidentId, bytes)).json<Slot>();
    await put(s.upload?.url ?? '', s.upload?.headers ?? {}, bytes);
    await asPhone(t.app, phone, {
      method: 'POST',
      url: `/api/v1/attachments/${s.attachmentId}/complete`,
      body: { sha256: '0'.repeat(64) },
    });
    await processPhotos();
    expect(await attachment(s.attachmentId)).toMatchObject({
      status: 'REJECTED',
      rejection_reason: 'HASH_MISMATCH',
    });
  });

  it('ADV-F03 a guessed or altered storage link is refused', async () => {
    const { phone, incidentId } = await onShiftWithIncident();
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#333' } })
      .jpeg()
      .toBuffer();
    const id = await upload(phone, incidentId, bytes);
    const link = (
      await call(t.app, {
        method: 'GET',
        url: `/api/v1/attachments/${id}/url`,
        cookie: supervisor,
        org: org.id,
      })
    ).json<{ url: string }>().url;
    const token = new URL(link).pathname.split('/').at(-1) ?? '';
    const [payload, mac] = token.split('.');
    // Another key in the same signed envelope: the signature no longer matches.
    const altered = Buffer.from(
      Buffer.from(payload ?? '', 'base64url')
        .toString('utf8')
        .replace(/"k":"[^"]+"/, `"k":"org/${org.id}/incidents/${incidentId}/${randomUUID()}/original"`),
    ).toString('base64url');
    for (const forged of [`${altered}.${mac}`, randomUUID(), `${payload}.${'A'.repeat(43)}`]) {
      const res = await t.app.inject({ method: 'GET', url: `/api/v1/local-objects/${forged}` });
      expect(res.statusCode, forged.slice(0, 20)).toBe(404);
    }
  });

  it('ADV-F04 ADV-T10 a signed link used after it expired is refused', async () => {
    const { phone, incidentId } = await onShiftWithIncident();
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#222' } })
      .jpeg()
      .toBuffer();
    const id = await upload(phone, incidentId, bytes);
    const link = (
      await call(t.app, {
        method: 'GET',
        url: `/api/v1/attachments/${id}/url`,
        cookie: supervisor,
        org: org.id,
      })
    ).json<{ url: string }>().url;
    expect((await t.app.inject({ method: 'GET', url: new URL(link).pathname })).statusCode).toBe(200);
    t.clock.advance(5 * 60_000 + 1_000);
    expect((await t.app.inject({ method: 'GET', url: new URL(link).pathname })).statusCode).toBe(404);
  });
});

describe('ownership (SEC §12, INV-02)', () => {
  it("ADV-T10 another organization's attachment and another guard's incident or photo are not found", async () => {
    const mine = await onShiftWithIncident();
    const theirs = await onShiftWithIncident();
    const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#111' } })
      .jpeg()
      .toBuffer();
    // A guard can't add photos to another guard's report, or complete another guard's photo.
    expect((await slot(mine.phone, theirs.incidentId, bytes)).statusCode).toBe(404);
    const theirSlot = (await slot(theirs.phone, theirs.incidentId, bytes)).json<Slot>();
    const complete = await asPhone(t.app, mine.phone, {
      method: 'POST',
      url: `/api/v1/attachments/${theirSlot.attachmentId}/complete`,
      body: { sha256: sha256(bytes) },
    });
    expect(complete.statusCode).toBe(404);
    // Another organization's user never gets a link to this organization's photo.
    const other = await seedOrganization(t.db, 'Other photo Co', [
      { email: 'owner@other-photo.test', role: 'OWNER' },
    ]);
    const otherOwner = await signIn(t.app, 'owner@other-photo.test');
    const id = await upload(mine.phone, mine.incidentId, bytes);
    for (const path of [`/api/v1/attachments/${id}/url`, `/api/v1/attachments/${id}/original-url`]) {
      const res = await call(t.app, { method: 'GET', url: path, cookie: otherOwner, org: other.id });
      expect(res.statusCode, path).toBe(404);
    }
  });
});
