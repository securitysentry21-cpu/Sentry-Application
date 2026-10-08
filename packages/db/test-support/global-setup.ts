// Vitest global setup: one PostgreSQL server per test project, roles bootstrapped once.
import pg from 'pg';
import type { TestProject } from 'vitest/node';

import { bootstrapRoles } from '../src/roles.ts';
import { startCluster } from './cluster.ts';
import './index.ts'; // brings in the ProvidedContext typing for project.provide()

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const cluster = await startCluster();
  const admin = new pg.Client({ connectionString: cluster.adminUrl });
  await admin.connect();
  try {
    await bootstrapRoles(admin);
  } finally {
    await admin.end();
  }
  project.provide('adminUrl', cluster.adminUrl);
  return cluster.stop;
}
