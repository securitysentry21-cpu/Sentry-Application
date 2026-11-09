// Review L-07: a handler's result must be what its route declares. Fastify sends whatever a
// handler returns, so a handler that spread a database row (`...row`) would send every column,
// coordinates included, past ADV-X05, which reads only the declared schemas.
// - Outside production (tests, `next dev`, the browser tests) every JSON response is parsed against
//   its route's schema for its status code, and a key the schema does not declare, or a response
//   that does not parse, fails the request loudly (checkResponse).
// - In production (owner decision Q6, Fable pass 2) a failure there would turn an accepted SOS into
//   a 500 that the phone retries for ever, so nothing fails: keys the schema does not declare are
//   dropped, and a response that still does not match is sent as it is, with one log line
//   (stripResponse).
import type { z } from 'zod';

export class ResponseMismatchError extends Error {}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The first path where `sent` holds a key that `declared` (the parsed, stripped copy) does not. */
export function undeclaredKey(sent: unknown, declared: unknown, path = '$'): string | null {
  if (Array.isArray(sent) && Array.isArray(declared)) {
    for (let i = 0; i < sent.length; i++) {
      const found = undeclaredKey(sent[i], declared[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (isPlainObject(sent) && isPlainObject(declared)) {
    for (const key of Object.keys(sent)) {
      if (!(key in declared)) return `${path}.${key}`;
      const found = undeclaredKey(sent[key], declared[key], `${path}.${key}`);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Checks one response. `route` names it in the error. A result that is not JSON data (nothing, a
 * Buffer, a stream, the reply itself after the handler sent bytes) is not checked.
 */
export function checkResponse(
  route: string,
  status: number,
  responses: Readonly<Record<number, z.ZodType>>,
  result: unknown,
): void {
  if (result === undefined || result === null || typeof result !== 'object') return;
  if (Buffer.isBuffer(result) || typeof (result as { pipe?: unknown }).pipe === 'function') return;
  const schema = responses[status];
  if (!schema)
    throw new ResponseMismatchError(`${route} answered ${status}, which it declares no schema for`);
  // What the client receives: dates as strings, undefined dropped.
  const sent: unknown = JSON.parse(JSON.stringify(result));
  const parsed = schema.safeParse(sent);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ResponseMismatchError(
      `${route} (${status}) does not match its response schema at $.${issue?.path.join('.') ?? ''}: ${issue?.message ?? ''}`,
    );
  }
  const extra = undeclaredKey(sent, parsed.data);
  if (extra)
    throw new ResponseMismatchError(`${route} (${status}) sends ${extra}, which its schema does not declare`);
}

/** `sent` with only the keys `declared` (the parsed copy) holds, at every depth; values from `sent`. */
function keepDeclared(sent: unknown, declared: unknown): unknown {
  if (Array.isArray(sent) && Array.isArray(declared)) {
    return sent.map((item, i) => keepDeclared(item, declared[i]));
  }
  if (isPlainObject(sent) && isPlainObject(declared)) {
    const kept: Record<string, unknown> = {};
    for (const key of Object.keys(sent)) {
      if (key in declared) kept[key] = keepDeclared(sent[key], declared[key]);
    }
    return kept;
  }
  return sent;
}

/** Deletes `keys` from the object at `path` inside `root`, where zod reported them undeclared. */
function deleteKeys(root: unknown, path: readonly PropertyKey[], keys: readonly string[]): void {
  let node: unknown = root;
  for (const step of path) {
    if (node === null || typeof node !== 'object') return;
    node = (node as Record<PropertyKey, unknown>)[step];
  }
  if (isPlainObject(node)) for (const key of keys) delete node[key];
}

export type MismatchLog = { warn(fields: Record<string, unknown>, message: string): void };

/**
 * Production (owner decision Q6): sends only what the route's schema declares, and never fails.
 * Values are the handler's own (only keys are dropped), so a schema's defaults or transforms change
 * nothing. A strict schema reports undeclared keys as errors; those keys are dropped and the
 * response parsed again. Whatever still does not match is sent as it is, and logged by route,
 * status and path only (never a value).
 */
export function stripResponse(
  route: string,
  status: number,
  responses: Readonly<Record<number, z.ZodType>>,
  result: unknown,
  log: MismatchLog,
): unknown {
  if (result === undefined || result === null || typeof result !== 'object') return result;
  if (Buffer.isBuffer(result) || typeof (result as { pipe?: unknown }).pipe === 'function') return result;
  const schema = responses[status];
  if (!schema) {
    log.warn({ route, status, problem: 'no schema for this status' }, 'response-mismatch');
    return result;
  }
  try {
    const original: unknown = JSON.parse(JSON.stringify(result));
    const sent: unknown = JSON.parse(JSON.stringify(result));
    let parsed = schema.safeParse(sent);
    if (!parsed.success && parsed.error.issues.every((issue) => issue.code === 'unrecognized_keys')) {
      for (const issue of parsed.error.issues) {
        if (issue.code === 'unrecognized_keys') deleteKeys(sent, issue.path, issue.keys);
      }
      parsed = schema.safeParse(sent);
    }
    if (!parsed.success) {
      const at = `$.${parsed.error.issues[0]?.path.join('.') ?? ''}`;
      log.warn({ route, status, at, problem: 'does not parse; sent as it is' }, 'response-mismatch');
      return result;
    }
    const dropped = undeclaredKey(original, parsed.data);
    if (dropped)
      log.warn({ route, status, at: dropped, problem: 'undeclared keys dropped' }, 'response-mismatch');
    return keepDeclared(sent, parsed.data);
  } catch {
    log.warn({ route, status, problem: 'check failed; sent as it is' }, 'response-mismatch');
    return result;
  }
}
