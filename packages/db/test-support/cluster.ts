// A PostgreSQL server for tests. CI provides one through TEST_DATABASE_ADMIN_URL (a postgres:17
// service container). Locally an embedded PostgreSQL 17 starts in a child process
// (embedded-server.ts explains why it must not run inside the Vitest process), so no Docker is needed.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export type Cluster = { adminUrl: string; stop: () => Promise<void> };

const SERVER_SCRIPT = fileURLToPath(new URL('./embedded-server.ts', import.meta.url));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

export async function startCluster(): Promise<Cluster> {
  const external = process.env.TEST_DATABASE_ADMIN_URL;
  if (external) return { adminUrl: external, stop: async () => {} };

  const port = await freePort();
  const dir = await mkdtemp(join(tmpdir(), 'sentryops-pg-'));
  const child = spawn(process.execPath, [SERVER_SCRIPT, String(port), join(dir, 'data')], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('embedded PostgreSQL did not start within 90 s')),
      90_000,
    );
    const onEarlyExit = (code: number | null) =>
      reject(new Error(`embedded PostgreSQL exited early (code ${code})`));
    child.once('exit', onEarlyExit);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (!line.includes('"ready":true')) return;
      clearTimeout(timer);
      child.off('exit', onEarlyExit);
      // Only the ready line matters; an open pipe would keep the test runner alive at exit.
      lines.close();
      child.stdout.destroy();
      resolve();
    });
  });

  return {
    adminUrl: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    // Teardown never throws: a throwing teardown also confuses Vitest's exit code.
    stop: async () => {
      try {
        if (child.exitCode === null) {
          const exited = once(child, 'exit');
          child.stdin.end('stop\n');
          let timer: NodeJS.Timeout | undefined;
          const timeout = new Promise<'timeout'>((resolve) => {
            timer = setTimeout(resolve, 30_000, 'timeout');
          });
          const outcome = await Promise.race([exited, timeout]);
          clearTimeout(timer); // a pending timer would keep the test runner alive after the tests finish
          if (outcome === 'timeout') {
            console.warn('warning: embedded PostgreSQL did not stop within 30 s; killing it');
            child.kill();
          }
        }
        await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      } catch (error) {
        console.warn(`warning: embedded PostgreSQL teardown: ${(error as Error).message}`);
      }
    },
  };
}
