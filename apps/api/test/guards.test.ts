import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseCsv } from '../src/routes/guards.ts';
import {
  asPhone,
  call,
  createGuard,
  enrollPhone,
  errorCode,
  seedOrganization,
  signIn,
  startTestApp,
  type TestApp,
} from './support.ts';

let t: TestApp;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let admin: string;
let dispatcher: string;

beforeAll(async () => {
  t = await startTestApp();
  org = await seedOrganization(t.db, 'Guards Co', [
    { email: 'admin@guards.test', role: 'ADMIN' },
    { email: 'disp@guards.test', role: 'DISPATCHER' },
  ]);
  admin = await signIn(t.app, 'admin@guards.test');
  dispatcher = await signIn(t.app, 'disp@guards.test');
});

afterAll(async () => {
  await t?.close();
});

const importCsv = (csv: string, preview: boolean) =>
  call(t.app, {
    method: 'POST',
    url: `/api/v1/guards/import?preview=${preview}`,
    cookie: admin,
    org: org.id,
    body: { csv },
  });

describe('guards (PROD §4)', () => {
  it('administrators create guards; dispatchers only read them', async () => {
    const id = await createGuard(t.app, admin, org.id, {
      employeeNumber: 'A-1',
      displayName: 'Ali Raza',
      phone: '+923001112233',
    });
    const list = await call(t.app, { method: 'GET', url: '/api/v1/guards', cookie: dispatcher, org: org.id });
    expect(list.json<{ guards: { id: string; enrolled: boolean }[] }>().guards).toEqual(
      expect.arrayContaining([expect.objectContaining({ id, enrolled: false })]),
    );
    const denied = await call(t.app, {
      method: 'POST',
      url: '/api/v1/guards',
      cookie: dispatcher,
      org: org.id,
      body: { employeeNumber: 'A-2', displayName: 'X', phone: '+923001112234' },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('employee numbers and phone numbers are unique within the organization', async () => {
    await createGuard(t.app, admin, org.id, {
      employeeNumber: 'U-1',
      displayName: 'One',
      phone: '+923002220001',
    });
    const sameNumber = await call(t.app, {
      method: 'POST',
      url: '/api/v1/guards',
      cookie: admin,
      org: org.id,
      body: { employeeNumber: 'U-1', displayName: 'Two', phone: '+923002220002' },
    });
    expect(sameNumber.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', details: [{ path: 'employeeNumber' }] },
    });
    const samePhone = await call(t.app, {
      method: 'POST',
      url: '/api/v1/guards',
      cookie: admin,
      org: org.id,
      body: { employeeNumber: 'U-2', displayName: 'Two', phone: '+923002220001' },
    });
    expect(samePhone.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', details: [{ path: 'phone' }] },
    });
  });

  it('ADV-A10 identity fields in a body are rejected', async () => {
    const res = await call(t.app, {
      method: 'POST',
      url: '/api/v1/guards',
      cookie: admin,
      org: org.id,
      body: {
        employeeNumber: 'M-1',
        displayName: 'Mass',
        phone: '+923003330001',
        organizationId: org.id,
        userId: org.id,
      },
    });
    expect(errorCode(res)).toBe('VALIDATION_FAILED');
  });

  it('CSV import: preview validates every row; one bad row and nothing is created', async () => {
    const csv = [
      'employee_number,display_name,phone,preferred_locale',
      'C-1,"Bilal, Khan",+923004440001,ur',
      'C-2,Sana Iqbal,0300 4440002,en',
      'C-1,Duplicate,+923004440003,en',
    ].join('\r\n');
    const preview = await importCsv(csv, true);
    expect(preview.json()).toMatchObject({ preview: true, total: 3, valid: 1, created: 0 });
    const errors = preview.json<{ errors: { row: number; field: string }[] }>().errors;
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 3, field: 'phone' }),
        expect.objectContaining({ row: 4, field: 'employee_number' }),
      ]),
    );
    expect((await importCsv(csv, false)).json()).toMatchObject({ created: 0 });
    const good =
      'employee_number,display_name,phone\nC-10,Bilal Khan,+923004440010\nC-11,Sana Iqbal,+923004440011\n';
    expect((await importCsv(good, false)).json()).toMatchObject({
      preview: false,
      valid: 2,
      created: 2,
      errors: [],
    });
  });

  it('the CSV parser handles quotes, commas, newlines in quotes and a byte-order mark', () => {
    expect(parseCsv('﻿a,b\n"x, y","he said ""hi"""\n"multi\nline",z\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
      ['multi\nline', 'z'],
    ]);
  });

  it('terminating a guard retires the phone and ends its session', async () => {
    const id = await createGuard(t.app, admin, org.id, {
      employeeNumber: 'T-1',
      displayName: 'Leaving',
      phone: '+923005550001',
    });
    const phone = await enrollPhone(t.app, admin, org.id, id, '+923005550001');
    const res = await call(t.app, {
      method: 'POST',
      url: `/api/v1/guards/${id}/terminate`,
      cookie: admin,
      org: org.id,
    });
    expect(res.json()).toMatchObject({ status: 'TERMINATED', enrolled: false });
    expect(errorCode(await asPhone(t.app, phone, { method: 'GET', url: '/api/v1/mobile/config' }))).toBe(
      'DEVICE_REVOKED',
    );
    // A terminated guard is gone from the list and from further changes.
    expect(
      (await call(t.app, { method: 'GET', url: `/api/v1/guards/${id}`, cookie: admin, org: org.id })).json(),
    ).toMatchObject({ status: 'TERMINATED' });
    expect(
      (
        await call(t.app, {
          method: 'POST',
          url: `/api/v1/guards/${id}/terminate`,
          cookie: admin,
          org: org.id,
        })
      ).statusCode,
    ).toBe(404);
  });
});
