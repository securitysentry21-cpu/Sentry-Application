// ADV-X04: the code and the spec must not drift (the "thresholds documented differently" lesson).
import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from '../src/audit.ts';
import { ERROR_CODES } from '../src/errors.ts';
import { SETTINGS, type SettingKey } from '../src/settings.ts';
import { readDoc, section, stripMarkdown, tableRows } from './support/markdown.ts';

type Parsed = { kind: 'scalar'; value: unknown } | { kind: 'text'; value: string };

function parseDefault(raw: string): Parsed {
  const cell = stripMarkdown(raw);
  if (/^-?[\d,]+(\.\d+)?$/.test(cell)) return { kind: 'scalar', value: Number(cell.replace(/,/g, '')) };
  if (cell === 'true' || cell === 'false') return { kind: 'scalar', value: cell === 'true' };
  if (/^[A-Z][A-Z_]*$/.test(cell)) return { kind: 'scalar', value: cell };
  if (cell === '[]') return { kind: 'scalar', value: [] };
  if (cell === '—') return { kind: 'scalar', value: null };
  return { kind: 'text', value: cell };
}

describe('spec consistency', () => {
  it('ADV-X04 settings defaults match PROD Appendix B', () => {
    const rows = tableRows(section(readDoc('PRODUCT_SPEC.md'), '## Appendix B'));
    const specKeys = new Set<string>();
    for (const [rawKey, rawDefault] of rows) {
      const key = stripMarkdown(rawKey ?? '');
      specKeys.add(key);
      expect(SETTINGS, `PROD Appendix B lists ${key}, but the contracts do not`).toHaveProperty([key]);
      const def = SETTINGS[key as SettingKey];
      const parsed = parseDefault(rawDefault ?? '');
      if (parsed.kind === 'scalar') {
        expect(def.default, `default of ${key}`).toEqual(parsed.value);
      } else {
        // Structured defaults (routing, escalation ladder) are described in prose in the spec.
        expect(typeof def.default, `${key} is structured`).toBe('object');
      }
    }
    expect([...specKeys].sort()).toEqual(Object.keys(SETTINGS).sort());
  });

  it('ADV-X04 error codes match ARCH Appendix B', () => {
    const rows = tableRows(section(readDoc('ARCHITECTURE.md'), '## Appendix B'));
    const spec = Object.fromEntries(rows.map(([code, http]) => [stripMarkdown(code ?? ''), Number(http)]));
    const code = Object.fromEntries(Object.entries(ERROR_CODES).map(([k, v]) => [k, v.http]));
    expect(code).toEqual(spec);
  });

  it('ADV-X04 audit actions match SEC §17.1', () => {
    const rows = tableRows(section(readDoc('SECURITY_AND_INVARIANTS.md'), '### 17.1 Actions'));
    // The spec annotates some actions, e.g. "INCIDENT_CREATED (dashboard)"; the note is not part of the name.
    const spec = rows.flatMap(([, actions]) =>
      (actions ?? '').split(',').map((a) => stripMarkdown(a).replace(/\s*\(.*?\)\s*$/, '')),
    );
    expect([...spec].sort()).toEqual([...AUDIT_ACTIONS].sort());
  });
});
