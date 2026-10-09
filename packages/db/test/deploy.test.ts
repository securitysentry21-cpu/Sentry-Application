// The cloud database setup (src/deploy.ts), run the way RDS allows: as an administrator that is not
// a superuser, with CREATEROLE, CREATEDB and ADMIN OPTION on the roles it created. A superuser would
// hide the permission errors that only show up in AWS.
import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { deployDatabase } from '../src/deploy.ts';
import { loadMigrations } from '../src/migrate.ts';
import { DEV_PASSWORDS, MIGRATOR, RUNTIME_ROLES } from '../src/roles.ts';

const ADMIN = `rds_like_admin_${randomBytes(4).toString('hex')}`;
const ADMIN_PASSWORD = randomBytes(16).toString('hex');
const DATABASE = `deploy_test_${randomBytes(4).toString('hex')}`;
let superuserUrl: string;

async function asSuperuser<T>(work: (c: pg.Client) => Promise<T>, database = 'postgres'): Promise<T> {
  const url = new URL(superuserUrl);
  url.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  superuserUrl = inject('adminUrl');
  await asSuperuser(async (c) => {
    await c.query(`create role ${ADMIN} login createrole createdb nosuperuser password '${ADMIN_PASSWORD}'`);
    // On RDS the master user created the roles, so it holds ADMIN OPTION on them. The test cluster's
    // roles were created by the harness, so grant that here. Passwords stay the shared dev ones.
    for (const role of [MIGRATOR, ...RUNTIME_ROLES])
      await c.query(`grant ${role} to ${ADMIN} with admin option, set false`);
  });
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    await c.query(`drop database if exists ${DATABASE} with (force)`);
    await c.query(`drop owned by ${ADMIN}`).catch(() => undefined);
    await c.query(`drop role if exists ${ADMIN}`);
  });
});

describe('cloud database setup (ARCH §19.8)', () => {
  const url = () => new URL(superuserUrl);
  const run = () =>
    deployDatabase({
      connection: { host: url().hostname, port: Number(url().port) },
      admin: { user: ADMIN, password: ADMIN_PASSWORD },
      database: DATABASE,
      passwords: DEV_PASSWORDS,
    });

  it('creates the database owned by migrator and applies every migration, as a non-superuser administrator', async () => {
    const result = await run();
    expect(result.createdDatabase).toBe(true);
    expect(result.applied).toEqual((await loadMigrations()).map((m) => m.version));

    const owner = await asSuperuser((c) =>
      c.query<{ owner: string; encoding: string }>(
        `select pg_get_userbyid(datdba) as owner, pg_encoding_to_char(encoding) as encoding from pg_database where datname = $1`,
        [DATABASE],
      ),
    );
    expect(owner.rows[0]).toEqual({ owner: MIGRATOR, encoding: 'UTF8' });

    // The runtime roles stay unprivileged: no superuser, no BYPASSRLS (D-33).
    const roles = await asSuperuser((c) =>
      c.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
        'select rolname, rolsuper, rolbypassrls from pg_roles where rolname = any($1) order by rolname',
        [[MIGRATOR, ...RUNTIME_ROLES]],
      ),
    );
    expect(roles.rows).toHaveLength(4);
    for (const r of roles.rows)
      expect([r.rolname, r.rolsuper, r.rolbypassrls]).toEqual([r.rolname, false, false]);
  });

  it('is idempotent: a second run changes nothing', async () => {
    expect(await run()).toEqual({ createdDatabase: false, applied: [] });
  });

  it('the runtime role can connect to the new database and is held to row-level security', async () => {
    const appUrl = url();
    appUrl.username = 'app_runtime';
    appUrl.password = DEV_PASSWORDS.app_runtime;
    appUrl.pathname = `/${DATABASE}`;
    const client = new pg.Client({ connectionString: appUrl.toString() });
    await client.connect();
    try {
      // No organization context: RLS shows nothing, and the role can't switch it off.
      const { rows } = await client.query<{ n: string }>('select count(*) as n from organizations');
      expect(rows[0]?.n).toBe('0');
      await expect(client.query('alter table organizations disable row level security')).rejects.toThrow();
    } finally {
      await client.end();
    }
  });
});
