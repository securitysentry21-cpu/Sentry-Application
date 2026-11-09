// Review L-07: a handler's result must be what its route declares. Fastify sends whatever a
// handler returns, so a handler that spread a database row (`...row`) would send every column,
// coordinates included, past ADV-X05, which reads only the declared schemas. Outside production
// (tests, `next dev`, the browser tests) every JSON response is parsed against its route's schema
// for its status code, and a key the schema does not declare, or a response that does not parse,
// fails the request loudly. Production does not run it: there a mismatch would turn an accepted
// SOS into a 500 that the phone retries for ever.
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
