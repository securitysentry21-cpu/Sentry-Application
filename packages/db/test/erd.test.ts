import { readFile, writeFile } from 'node:fs/promises';

import pg from 'pg';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { generateErd } from '../src/erd.ts';
import { createTestDatabase, type TestDatabase } from '../test-support/index.ts';

const ERD_FILE = new URL('../../../docs/generated/erd.md', import.meta.url);
let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase(inject('adminUrl'));
});

afterAll(async () => {
  await db?.drop();
});

it('ADV-X04 docs/generated/erd.md matches the migrated schema', async () => {
  const client = new pg.Client({ connectionString: db.urls.migrator });
  await client.connect();
  let erd: string;
  try {
    erd = await generateErd(client);
  } finally {
    await client.end();
  }
  if (process.env.UPDATE_GENERATED === '1') await writeFile(ERD_FILE, erd);
  const committed = await readFile(ERD_FILE, 'utf8').catch(() => '(missing — run with UPDATE_GENERATED=1)');
  expect(committed).toBe(erd);
});
