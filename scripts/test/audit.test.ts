// SEC §14: the dependency audit fails closed (review L-10) and an exception covers only what it
// names (review L-21).
import { describe, expect, it } from 'vitest';

import { type AllowEntry, evaluateAudit } from '../lib/audit.ts';

const TODAY = '2026-11-09';
const ZOD_ENTRY: AllowEntry = {
  id: 'GHSA-mrhx-c7xc-m3w5',
  package: 'zod@3.25.76',
  paths: ['>@expo/cli>zod'],
  reason: 'The Expo CLI private zod 3 copy, used by the dev server only, never on user data.',
  reviewed: '2026-11-01',
  expires: '2027-01-30',
};

function advisory(version: string, paths: string[], severity = 'high') {
  return {
    github_advisory_id: 'GHSA-mrhx-c7xc-m3w5',
    module_name: 'zod',
    severity,
    title: 'Memory exhaustion',
    url: 'https://github.com/advisories/GHSA-mrhx-c7xc-m3w5',
    findings: [{ version, paths }],
  };
}

const report = (...advisories: unknown[]) => ({
  advisories: Object.fromEntries(advisories.map((a, i) => [String(i + 1), a])),
  metadata: { vulnerabilities: {} },
});

describe('the dependency audit fails closed (review L-10)', () => {
  it.each([
    ['the audit endpoint failed', { error: { code: 'ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS' } }],
    ['an empty object', {}],
    ['advisories without metadata', { advisories: {} }],
    ['an error next to advisories', { ...report(), error: { code: 'ERR_X' } }],
    ['not JSON at all', undefined],
    ['a list', []],
  ])('refuses a report that is %s', (_name, payload) => {
    expect(evaluateAudit(payload, [ZOD_ENTRY], TODAY).unreadable).toBeDefined();
  });

  it('reads a real report with nothing in it as clean', () => {
    const outcome = evaluateAudit(report(), [], TODAY);
    expect(outcome.unreadable).toBeUndefined();
    expect(outcome.blocking).toEqual([]);
  });
});

describe('an exception covers only the version and paths it names (review L-21)', () => {
  it('covers the Expo CLI copy it was written for', () => {
    const outcome = evaluateAudit(
      report(
        advisory('3.25.76', [
          'apps__mobile>expo>@expo/cli>zod',
          'apps__mobile>expo-camera>expo>@expo/cli>zod',
        ]),
      ),
      [ZOD_ENTRY],
      TODAY,
    );
    expect(outcome.blocking).toEqual([]);
    expect(outcome.allowed).toHaveLength(1);
    expect(outcome.stale).toEqual([]);
  });

  it('blocks the same advisory in the API, even at the same version', () => {
    const outcome = evaluateAudit(
      report(advisory('3.25.76', ['apps__mobile>expo>@expo/cli>zod', 'apps__api>zod'])),
      [ZOD_ENTRY],
      TODAY,
    );
    expect(outcome.blocking.map((a) => a.id)).toEqual(['GHSA-mrhx-c7xc-m3w5']);
  });

  it('blocks another vulnerable version of the package', () => {
    const outcome = evaluateAudit(
      report(advisory('4.6.5', ['apps__mobile>expo>@expo/cli>zod'])),
      [ZOD_ENTRY],
      TODAY,
    );
    expect(outcome.blocking).toHaveLength(1);
  });

  it('blocks once the entry has expired, and reports it', () => {
    const outcome = evaluateAudit(
      report(advisory('3.25.76', ['apps__mobile>expo>@expo/cli>zod'])),
      [ZOD_ENTRY],
      '2027-02-01',
    );
    expect(outcome.blocking).toHaveLength(1);
    expect(outcome.expired).toEqual([ZOD_ENTRY]);
  });

  it('refuses entries without an exact version or the paths they cover', () => {
    const { paths: _paths, ...withoutPaths } = ZOD_ENTRY;
    const invalid = evaluateAudit(
      report(),
      [{ ...ZOD_ENTRY, package: 'zod' }, withoutPaths as AllowEntry],
      TODAY,
    ).invalid;
    expect(invalid.join('\n')).toMatch(/package must be name@version/);
    expect(invalid.join('\n')).toMatch(/paths must name where/);
  });

  it('counts lower severities without blocking, and calls an unused entry stale', () => {
    const outcome = evaluateAudit(
      report(advisory('3.25.76', ['apps__api>zod'], 'moderate')),
      [ZOD_ENTRY],
      TODAY,
    );
    expect(outcome.blocking).toEqual([]);
    expect(outcome.lower).toBe(1);
    expect(outcome.stale).toEqual([ZOD_ENTRY]);
  });
});
