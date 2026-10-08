import { Writable } from 'node:stream';

import { createPool } from '@sentryops/db';
import { FakeClock } from '@sentryops/domain';
import pino from 'pino';
import { expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { loggerOptions } from '../src/logger.ts';
import { NOW, testConfig, UNREACHABLE_DATABASE } from './support.ts';

function collector(): { sink: Writable; lines: string[] } {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(...chunk.toString().split('\n').filter(Boolean));
      done();
    },
  });
  return { sink, lines };
}

it('SEC §15 the logger redacts tokens, codes, coordinates, incident text and phone numbers', () => {
  const { sink, lines } = collector();
  const log = pino(loggerOptions('info'), sink);

  log.info(
    {
      token: 'tok-SECRET',
      otp: '493021',
      phone: '+923001234567',
      fix: { lat: 24.8607, lon: 67.0011 },
      item: { description: 'intruder at gate 3', qrToken: 'SG1:abcdefghijklmnopqrstuv', latitude: 24.9 },
      req: { headers: { authorization: 'Bearer SECRET-JWT', cookie: 'session=SECRET-COOKIE' } },
      organizationId: '018f0000-0000-7000-8000-00000000000a',
    },
    'probe',
  );

  const out = lines.join('');
  for (const secret of [
    'tok-SECRET',
    '493021',
    '+923001234567',
    '24.8607',
    '67.0011',
    'intruder at gate 3',
    'SG1:abcdefghijklmnopqrstuv',
    '24.9',
    'SECRET-JWT',
    'SECRET-COOKIE',
  ]) {
    expect(out, `leaked ${secret}`).not.toContain(secret);
  }
  expect(out).toContain('[Redacted]');
  // IDs are what logs are for.
  expect(out).toContain('018f0000-0000-7000-8000-00000000000a');
});

it('SEC §15 every log line written while serving a request carries its request_id', async () => {
  const { sink, lines } = collector();
  const pool = createPool(UNREACHABLE_DATABASE);
  const app = buildApp(
    { pool, clock: new FakeClock(NOW), config: testConfig(UNREACHABLE_DATABASE) },
    { logger: { ...loggerOptions('info'), stream: sink } },
  );
  try {
    await app.inject({ method: 'GET', url: '/api/v1/health', headers: { 'x-request-id': 'req-42' } });
  } finally {
    await app.close();
    await pool.end();
  }

  const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const forRequest = entries.filter((e) => 'request_id' in e || 'reqId' in e);
  expect(forRequest.length).toBeGreaterThanOrEqual(2); // "incoming request" and "request completed"
  for (const entry of forRequest) {
    expect(entry.request_id).toBe('req-42');
    expect(entry).not.toHaveProperty('reqId');
  }
});
