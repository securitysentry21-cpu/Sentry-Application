import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveScannedCheckpoint } from '../src/qr.ts';
import { asOwner, call, errorCode, seedOrganization, signIn, startTestApp, type TestApp } from './support.ts';

let t: TestApp;
let orgA: Awaited<ReturnType<typeof seedOrganization>>;
let orgB: Awaited<ReturnType<typeof seedOrganization>>;
let adminA: string;
let adminB: string;

// A small square beat around a point in the colony, in degrees (≈ 450 m sides).
const BEAT = [
  { lat: 31.47, lng: 74.4 },
  { lat: 31.47, lng: 74.4048 },
  { lat: 31.4741, lng: 74.4048 },
  { lat: 31.4741, lng: 74.4 },
];

const createSite = (cookie: string, orgId: string, body: Record<string, unknown>) =>
  call(t.app, { method: 'POST', url: '/api/v1/sites', cookie, org: orgId, body });

beforeAll(async () => {
  t = await startTestApp();
  orgA = await seedOrganization(t.db, 'Alpha', [{ email: 'admin@a-sites.test', role: 'ADMIN' }]);
  orgB = await seedOrganization(t.db, 'Bravo', [{ email: 'admin@b-sites.test', role: 'ADMIN' }]);
  adminA = await signIn(t.app, 'admin@a-sites.test');
  adminB = await signIn(t.app, 'admin@b-sites.test');
});

afterAll(async () => {
  await t?.close();
});

describe('sites (D-38)', () => {
  it('a post with a circle and a patrol beat with a drawn polygon', async () => {
    const post = await createSite(adminA, orgA.id, {
      name: 'Main gate',
      boundary: { kind: 'CIRCLE', center: { lat: 31.47, lng: 74.4 }, radiusM: 150 },
    });
    expect(post.statusCode).toBe(201);
    expect(post.json()).toMatchObject({
      boundary: { kind: 'CIRCLE', radiusM: 150 },
      center: { lat: 31.47, lng: 74.4 },
      timezone: 'Asia/Karachi',
    });
    const beat = await createSite(adminA, orgA.id, {
      name: 'Sector C beat',
      boundary: { kind: 'POLYGON', points: BEAT },
    });
    expect(beat.statusCode).toBe(201);
    const center = beat.json<{ center: { lat: number; lng: number } }>().center;
    expect(center.lat).toBeCloseTo(31.47205, 4);
  });

  it('a polygon that crosses itself, or covers more than 100 km², is refused', async () => {
    const bowTie = [BEAT[0], BEAT[2], BEAT[1], BEAT[3]];
    expect(
      errorCode(
        await createSite(adminA, orgA.id, { name: 'Bad', boundary: { kind: 'POLYGON', points: bowTie } }),
      ),
    ).toBe('VALIDATION_FAILED');
    const huge = [
      { lat: 31.3, lng: 74.2 },
      { lat: 31.3, lng: 74.4 },
      { lat: 31.5, lng: 74.4 },
      { lat: 31.5, lng: 74.2 },
    ]; // ≈ 420 km²: the whole colony, not a beat
    const res = await createSite(adminA, orgA.id, {
      name: 'Huge',
      boundary: { kind: 'POLYGON', points: huge },
    });
    expect(res.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', details: [{ path: 'boundary.points' }] },
    });
    expect(
      errorCode(
        await createSite(adminA, orgA.id, {
          name: 'Tiny',
          boundary: { kind: 'CIRCLE', center: BEAT[0], radiusM: 20 },
        }),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('changing the boundary is audited as a geofence change', async () => {
    const site = (
      await createSite(adminA, orgA.id, {
        name: 'Reshaped',
        boundary: { kind: 'CIRCLE', center: BEAT[0], radiusM: 100 },
      })
    ).json<{ id: string; version: number }>();
    const res = await call(t.app, {
      method: 'PATCH',
      url: `/api/v1/sites/${site.id}`,
      cookie: adminA,
      org: orgA.id,
      body: { boundary: { kind: 'POLYGON', points: BEAT }, version: site.version },
    });
    expect(res.json()).toMatchObject({ boundary: { kind: 'POLYGON' }, version: site.version + 1 });
    const { rows } = await asOwner(t.db, (c) =>
      c.query<{ action: string }>(
        `select action from audit_logs where resource_id = $1 order by created_at`,
        [site.id],
      ),
    );
    expect(rows.map((r) => r.action)).toEqual(['SITE_CREATED', 'SITE_UPDATED', 'GEOFENCE_CHANGED']);
  });
});

describe('checkpoints and QR labels (ARCH §11.1)', () => {
  async function siteWithCheckpoint() {
    const site = (
      await createSite(adminA, orgA.id, {
        name: `Gate ${randomUUID().slice(0, 4)}`,
        boundary: { kind: 'CIRCLE', center: BEAT[0], radiusM: 200 },
      })
    ).json<{ id: string }>();
    const cp = await call(t.app, {
      method: 'POST',
      url: `/api/v1/sites/${site.id}/checkpoints`,
      cookie: adminA,
      org: orgA.id,
      body: { name: 'North door', location: BEAT[0] },
    });
    expect(cp.statusCode).toBe(201);
    return { siteId: site.id, checkpoint: cp.json<{ id: string; qrVersion: number }>() };
  }

  const sheet = (siteId: string, cookie = adminA, orgId = orgA.id) =>
    call(t.app, {
      method: 'GET',
      url: `/api/v1/sites/${siteId}/checkpoints/print-sheet`,
      cookie,
      org: orgId,
    });

  it('the print sheet carries SG1 labels, and printing is audited', async () => {
    const { siteId, checkpoint } = await siteWithCheckpoint();
    const labels = (await sheet(siteId)).json<{ labels: { checkpointId: string; qrContent: string }[] }>()
      .labels;
    expect(labels).toEqual([
      expect.objectContaining({
        checkpointId: checkpoint.id,
        qrContent: expect.stringMatching(/^SG1:[A-Za-z0-9_-]{22}$/) as unknown,
      }),
    ]);
    // The label is never stored: the database holds only its hash.
    const { rows } = await asOwner(t.db, (c) =>
      c.query<{ h: Buffer }>('select qr_token_hash as h from checkpoints where id = $1', [checkpoint.id]),
    );
    expect(rows[0]?.h.toString('utf8')).not.toContain(labels[0]?.qrContent.slice(4) ?? 'x');
    const { rows: audit } = await asOwner(t.db, (c) =>
      c.query(`select 1 from audit_logs where action = 'CHECKPOINT_QR_PRINTED' and resource_id = $1`, [
        siteId,
      ]),
    );
    expect(audit).toHaveLength(1);
  });

  it('ADV-Q05 an old label after rotation is INVALID_QR; the new one resolves', async () => {
    const { siteId, checkpoint } = await siteWithCheckpoint();
    const old = (await sheet(siteId)).json<{ labels: { qrContent: string }[] }>().labels[0]?.qrContent ?? '';
    expect(await resolveScannedCheckpoint(t.deps.db, orgA.id, old)).toMatchObject({
      ok: true,
      checkpoint: { id: checkpoint.id },
    });
    const rotated = await call(t.app, {
      method: 'POST',
      url: `/api/v1/checkpoints/${checkpoint.id}/rotate-qr`,
      cookie: adminA,
      org: orgA.id,
    });
    expect(rotated.json()).toMatchObject({ qrVersion: 2 });
    expect(await resolveScannedCheckpoint(t.deps.db, orgA.id, old)).toEqual({
      ok: false,
      code: 'INVALID_QR',
    });
    const fresh =
      (await sheet(siteId)).json<{ labels: { qrContent: string }[] }>().labels[0]?.qrContent ?? '';
    expect(fresh).not.toBe(old);
    expect(await resolveScannedCheckpoint(t.deps.db, orgA.id, fresh)).toMatchObject({ ok: true });
    // Another organization's label answers exactly like an unknown one.
    expect(await resolveScannedCheckpoint(t.deps.db, orgB.id, fresh)).toEqual({
      ok: false,
      code: 'INVALID_QR',
    });
    expect(await resolveScannedCheckpoint(t.deps.db, orgA.id, 'SG1:AAAAAAAAAAAAAAAAAAAAAA')).toEqual({
      ok: false,
      code: 'INVALID_QR',
    });
  });

  it("ADV-T05 another organization's administrator gets 404 for the print sheet and rotation", async () => {
    const { siteId, checkpoint } = await siteWithCheckpoint();
    expect((await sheet(siteId, adminB, orgB.id)).statusCode).toBe(404);
    const rotate = await call(t.app, {
      method: 'POST',
      url: `/api/v1/checkpoints/${checkpoint.id}/rotate-qr`,
      cookie: adminB,
      org: orgB.id,
    });
    expect(rotate.statusCode).toBe(404);
    expect((await sheet(siteId)).json<{ labels: { qrVersion: number }[] }>().labels[0]?.qrVersion).toBe(1);
  });

  it("ADV-T04 a checkpoint can't point at another organization's site, through the API or in the database", async () => {
    const { siteId } = await siteWithCheckpoint();
    const viaApi = await call(t.app, {
      method: 'POST',
      url: `/api/v1/sites/${siteId}/checkpoints`,
      cookie: adminB,
      org: orgB.id,
      body: { name: 'Sneaky' },
    });
    expect(viaApi.statusCode).toBe(404);
    await expect(
      asOwner(t.db, (c) =>
        c.query(
          `insert into checkpoints (id, organization_id, site_id, name, qr_token_hash) values ($1, $2, $3, 'x', $4)`,
          [randomUUID(), orgB.id, siteId, randomBytes(32)],
        ),
      ),
    ).rejects.toThrow(/foreign key/);
  });
});
