import { Writable } from 'node:stream';

import { createPool } from '@sentryops/db';
import { FakeClock } from '@sentryops/domain';
import { DatabaseError } from 'pg';
import pino from 'pino';
import { expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { createDeps } from '../src/server.ts';
import { failureLine, loggerOptions, REDACT_PATHS } from '../src/logger.ts';
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
  const options = loggerOptions('info');
  // Negative control (review L-18): one key dropped from the redaction list must turn this red.
  const planted =
    process.env.NEGATIVE_CONTROL === 'redaction-dropped'
      ? {
          ...options,
          redact: { paths: REDACT_PATHS.filter((p) => !p.endsWith('phone')), censor: '[Redacted]' },
        }
      : options;
  const log = pino(planted, sink);

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

// Review L-04: a constraint violation's `detail` holds the failing row, coordinates and phone included.
function failingRowError(): DatabaseError {
  const error = new DatabaseError(
    'new row for relation "location_points" violates check constraint "location_points_accuracy_check"',
    0,
    'error',
  );
  error.code = '23514';
  error.severity = 'ERROR';
  error.detail =
    'Failing row contains (019a…, 24.8607, 67.0011, Guard Ahmed +923001234567, intruder at gate 3).';
  error.where = 'SQL statement "insert … values (24.8607, 67.0011)"';
  error.internalQuery = "select '+923001234567'";
  error.hint = 'Check +923001234567';
  error.table = 'location_points';
  error.constraint = 'location_points_accuracy_check';
  return error;
}

const ROW_VALUES = ['24.8607', '67.0011', '+923001234567', 'Guard Ahmed', 'intruder at gate 3'];

it('SEC §15 a database error is logged without the row it carries (review L-04)', async () => {
  const { sink, lines } = collector();
  pino(loggerOptions('info'), sink).error({ err: failingRowError() }, 'unhandled error');

  // The logger Fastify builds from the same options (Fastify adds its own `err` serializer otherwise).
  const fastifyLines = collector();
  const pool = createPool(UNREACHABLE_DATABASE);
  const app = buildApp(
    createDeps(testConfig(UNREACHABLE_DATABASE), pool, { clock: new FakeClock(NOW), oidc: null }),
    { logger: { ...loggerOptions('info'), stream: fastifyLines.sink } },
  );
  try {
    await app.ready();
    app.log.error({ err: failingRowError() }, 'unhandled error');
  } finally {
    await app.close();
    await pool.end();
  }

  for (const out of [lines, fastifyLines.lines]) {
    const entry = JSON.parse(out.find((line) => line.includes('unhandled error')) ?? '{}') as {
      err?: Record<string, unknown>;
    };
    const text = JSON.stringify(entry);
    for (const value of ROW_VALUES) expect(text, `leaked ${value}`).not.toContain(value);
    // What the operator needs to find the cause stays.
    expect(entry.err).toMatchObject({
      type: 'DatabaseError',
      errorCode: '23514',
      table: 'location_points',
      constraint: 'location_points_accuracy_check',
    });
    expect(entry.err?.message).toContain('violates check constraint');
  }
});

// Review L-31: a data exception (SQLSTATE class 22) quotes the input in its message itself.
function dataExceptionError(): DatabaseError {
  const error = new DatabaseError('invalid input syntax for type integer: "+923001234567"', 0, 'error');
  error.code = '22P02';
  error.severity = 'ERROR';
  return error;
}

it('SEC §15 a data exception is logged by its condition, never the value it quotes (review L-31)', () => {
  const { sink, lines } = collector();
  pino(loggerOptions('info'), sink).error({ err: dataExceptionError() }, 'unhandled error');
  // The worker's loops write their own failure lines (the alarm filters match `msg`).
  const workerLine = failureLine('export runner failed', dataExceptionError());

  for (const line of [lines.find((l) => l.includes('unhandled error')) ?? '', workerLine]) {
    expect(line, 'leaked the value').not.toContain('923001234567');
    const entry = JSON.parse(line) as { err?: Record<string, unknown>; error?: Record<string, unknown> };
    const err = entry.err ?? entry.error;
    expect(err).toMatchObject({
      type: 'DatabaseError',
      errorCode: '22P02',
      message: 'invalid_text_representation',
    });
    // The stack keeps its frames, without the message's first line.
    expect(String(err?.stack)).toMatch(/^DatabaseError: invalid_text_representation\n\s+at /);
  }
  expect(JSON.parse(workerLine)).toMatchObject({ msg: 'export runner failed' });
});

it('SEC §15 every log line written while serving a request carries its request_id', async () => {
  const { sink, lines } = collector();
  const pool = createPool(UNREACHABLE_DATABASE);
  const app = buildApp(
    createDeps(testConfig(UNREACHABLE_DATABASE), pool, { clock: new FakeClock(NOW), oidc: null }),
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
