// The dependency audit's decision (SEC §14), apart from running pnpm so it can be tested
// (scripts/test/audit.test.ts): which advisories block, which allow-list entries are bad, expired
// or no longer needed.

export type AllowEntry = {
  id: string;
  /** The exact package version the exception covers, `name@version`. */
  package: string;
  /** Where it is reached: each dependency path of a covered finding contains one of these. */
  paths: string[];
  reason: string;
  reviewed: string;
  expires: string;
};

export type Advisory = { id: string; module: string; severity: string; title: string; url: string };

export type AuditOutcome = {
  /** Set when the report is not a usable audit (an error, a registry page, an empty object). */
  unreadable?: string;
  invalid: string[];
  expired: AllowEntry[];
  blocking: Advisory[];
  /** Allow-list entries that matched no finding: remove them. */
  stale: AllowEntry[];
  allowed: { advisory: Advisory; entry: AllowEntry }[];
  lower: number;
};

const MAX_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PACKAGE_AT_VERSION = /^(@[\w.-]+\/)?[\w.-]+@\d+\.\d+\.\d+[\w.+-]*$/;

const str = (value: unknown, fallback: string): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** An exception is only as good as its justification: vague or open-ended entries are refused. */
export function invalidEntries(entries: AllowEntry[]): string[] {
  const invalid: string[] = [];
  for (const a of entries) {
    const label = `allow-list entry ${a.id || '(no id)'}`;
    if (!/^GHSA-[\w-]+$/.test(a.id)) invalid.push(`${label}: id must be a GHSA advisory ID`);
    if (!PACKAGE_AT_VERSION.test(a.package ?? ''))
      invalid.push(`${label}: package must be name@version, exactly`);
    if (
      !Array.isArray(a.paths) ||
      a.paths.length === 0 ||
      !a.paths.every((p) => typeof p === 'string' && p.length >= 3)
    )
      invalid.push(`${label}: paths must name where the package is reached (dependency path fragments)`);
    if ((a.reason ?? '').trim().length < 40) invalid.push(`${label}: explain why it does not apply`);
    if (!ISO_DATE.test(a.reviewed ?? '') || !ISO_DATE.test(a.expires ?? '')) {
      invalid.push(`${label}: reviewed and expires must be YYYY-MM-DD dates`);
    } else if (Date.parse(a.expires) - Date.parse(a.reviewed) > MAX_DAYS * DAY_MS) {
      invalid.push(`${label}: expires more than ${MAX_DAYS} days after its review`);
    }
  }
  return invalid;
}

/**
 * Review L-21: an entry covers an advisory only where every finding is the entry's exact
 * name@version and every one of its dependency paths goes through a path the entry names. The same
 * advisory anywhere else (the API pulling in the same library) blocks.
 */
function covers(entry: AllowEntry, raw: Record<string, unknown>): boolean {
  const findings = Array.isArray(raw.findings) ? raw.findings.filter(isObject) : [];
  if (findings.length === 0) return false;
  const module = str(raw.module_name, '');
  return findings.every((f) => {
    if (`${module}@${str(f.version, '?')}` !== entry.package) return false;
    const paths = Array.isArray(f.paths) ? f.paths.map((p) => str(p, '')) : [];
    return paths.length > 0 && paths.every((p) => entry.paths.some((fragment) => p.includes(fragment)));
  });
}

export function evaluateAudit(report: unknown, entries: AllowEntry[], today: string): AuditOutcome {
  const invalid = invalidEntries(entries);
  const expired = entries.filter((a) => a.expires < today);
  const live = entries.filter((a) => a.expires >= today);
  const outcome: AuditOutcome = { invalid, expired, blocking: [], stale: [], allowed: [], lower: 0 };

  // Review L-10: pnpm prints {"error": …} and exits 0 when the audit endpoint fails. That is not
  // "no advisories"; a report without its advisories and metadata is not a report.
  if (!isObject(report) || 'error' in report || !isObject(report.advisories) || !isObject(report.metadata)) {
    const error =
      isObject(report) && isObject(report.error) ? str(report.error.code, 'error') : 'no advisories';
    return { ...outcome, unreadable: error };
  }

  const used = new Set<AllowEntry>();
  for (const raw of Object.values(report.advisories).filter(isObject)) {
    const advisory: Advisory = {
      id: str(raw.github_advisory_id, str(raw.id, '?')),
      module: str(raw.module_name, '?'),
      severity: str(raw.severity, 'unknown'),
      title: str(raw.title, ''),
      url: str(raw.url, ''),
    };
    if (!['high', 'critical'].includes(advisory.severity)) {
      outcome.lower++;
      continue;
    }
    const entry = live.find((e) => e.id === advisory.id && covers(e, raw));
    if (entry) {
      used.add(entry);
      outcome.allowed.push({ advisory, entry });
    } else {
      outcome.blocking.push(advisory);
    }
  }
  outcome.stale = live.filter((e) => !used.has(e));
  return outcome;
}
