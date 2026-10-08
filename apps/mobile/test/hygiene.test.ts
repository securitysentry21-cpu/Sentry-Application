import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createLogger, redactFields } from '../src/core/log.ts';
import { fixAt } from './support/fakes.ts';
import { SHIFT_1 } from './support/fake-server.ts';
import { makeApp, readyGuard, settle } from './support/harness.ts';

const SRC = join(import.meta.dirname, '..', 'src');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

describe('logging hygiene (SEC §11, §15)', () => {
  it('passes only allow-listed fields; tokens, codes, coordinates, phone numbers and text are redacted', () => {
    const out = redactFields({
      accessToken: 'secret-token',
      refreshToken: 'r',
      code: 'K7Q4-M9XP',
      phone: '+923001234567',
      lat: 24.86,
      lon: 67.0,
      fix: { lat: 1 },
      description: 'the back gate was open',
      batchId: '0190a0d2-7c5e-7000-8000-000000000001',
      httpStatus: 503,
      errorCode: 'NOT_READY',
      reason: 'free text with spaces, commas and a + sign',
    });
    expect(out).toEqual({
      accessToken: '[redacted]',
      refreshToken: '[redacted]',
      code: '[redacted]',
      phone: '[redacted]',
      lat: '[redacted]',
      lon: '[redacted]',
      fix: '[redacted]',
      description: '[redacted]',
      batchId: '0190a0d2-7c5e-7000-8000-000000000001',
      httpStatus: 503,
      errorCode: 'NOT_READY',
      reason: '[redacted]',
    });
  });

  it('a whole shift with an incident and an SOS writes no token, code, coordinate, phone number or incident text to the log', async () => {
    const h = await makeApp();
    await readyGuard(h);
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
    await h.app.onLocations([fixAt(h.clocks.wall.nowMs())]);
    await h.app.reportIncident({
      shiftId: SHIFT_1,
      type: 'THEFT',
      severity: 'HIGH',
      title: 'Secret title',
      description: 'Secret words',
    });
    await h.app.triggerSos();
    await settle();
    await h.app.flush({ urgent: true });
    const text = JSON.stringify(h.lines);
    expect(h.lines.length).toBeGreaterThan(5);
    for (const secret of [
      'access-',
      'refresh-',
      'K7Q4-M9XP',
      '3001234567',
      '24.86',
      '67.00',
      'Secret title',
      'Secret words',
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it('a throwing log sink never breaks the app', () => {
    const logger = createLogger(() => {
      throw new Error('disk full');
    });
    expect(() => logger.error('x', { count: 1 })).not.toThrow();
  });
});

describe('architecture', () => {
  it('src/core stays free of React Native and Expo, so it runs (and is tested) in Node', () => {
    const offenders: string[] = [];
    for (const file of files(join(SRC, 'core'))) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/from '([^']+)'/g)) {
        const mod = m[1] ?? '';
        if (
          mod === 'react' ||
          mod.startsWith('react-native') ||
          mod === 'expo' ||
          mod.startsWith('expo-') ||
          mod.startsWith('@expo/')
        ) {
          offenders.push(`${relative(SRC, file)} imports ${mod}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no console.* outside the logger, and no dangerouslySetInnerHTML anywhere', () => {
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      const text = readFileSync(file, 'utf8');
      if (
        /\bconsole\.(log|info|warn|error|debug)\b/.test(text) &&
        !file.endsWith(join('platform', 'logger.ts'))
      ) {
        offenders.push(relative(SRC, file));
      }
      if (text.includes('dangerouslySetInnerHTML'))
        offenders.push(`${relative(SRC, file)} (dangerouslySetInnerHTML)`);
    }
    expect(offenders).toEqual([]);
  });
});
