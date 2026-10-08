// Typing for the value global-setup.ts provides to every test file through inject('adminUrl').
declare module 'vitest' {
  export interface ProvidedContext {
    adminUrl: string;
  }
}

export { startCluster, type Cluster } from './cluster.ts';
export { createTestDatabase, FIXTURE_REGISTRY, type TestDatabase } from './database.ts';
