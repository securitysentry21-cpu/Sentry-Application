import { loadConfig } from './config.ts';
import { start } from './server.ts';

const app = await start(loadConfig(process.env));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
