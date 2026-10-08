// Runs embedded PostgreSQL in a process of its own.
//
// Why a separate process: importing `embedded-postgres` installs a global exit hook
// (async-exit-hook) that calls process.exit() with its own code. Inside Vitest that overwrote the
// failure exit code with 0, so failing tests "passed" — caught by the negative controls (ADV-X02).
// Isolated here, the hook can only affect this child.
//
// Protocol: argv = <port> <dataDir>. Prints one line `{"ready":true}` once accepting connections.
// Stops when it reads "stop" on stdin, or when stdin closes (the parent went away). An existing
// cluster in <dataDir> is reused (`pnpm db:up` keeps its data between runs); otherwise one is created.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import EmbeddedPostgres from 'embedded-postgres';

const [portArg, dataDir] = process.argv.slice(2);
if (!portArg || !dataDir) {
  console.error('usage: embedded-server.ts <port> <dataDir>');
  process.exit(2);
}

const server = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port: Number(portArg),
  persistent: true, // the parent removes the folder after this process has exited
  onLog: () => {},
  onError: (message: unknown) => {
    if (process.env.DEBUG_POSTGRES) console.error(String(message));
  },
});

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await server.stop();
  } finally {
    process.exit(0);
  }
}

// initdb refuses a directory that already holds a cluster; PG_VERSION marks one.
if (!existsSync(join(dataDir, 'PG_VERSION'))) await server.initialise();
await server.start();
process.stdout.write(`${JSON.stringify({ ready: true })}\n`);

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  if (chunk.includes('stop')) void shutdown();
});
process.stdin.on('end', () => void shutdown());
