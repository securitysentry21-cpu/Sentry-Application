// The one way request code touches tenant tables (ARCH §4.3): inside a transaction whose tenant
// context is set with set_config(..., is_local => true), the parameterised form of SET LOCAL.
// Session-level SET would leak to the next user of a pooled connection (SEC §20 item 2).
import type pg from 'pg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function withTenant<T>(
  pool: pg.Pool,
  organizationId: string,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (!UUID.test(organizationId)) throw new TypeError('organizationId must be a UUID');
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.org_id', $1, true)", [organizationId]);
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
