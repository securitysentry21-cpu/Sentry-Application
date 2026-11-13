// Fable pass 2, review L-36: the dashboard's Content-Security-Policy, checked on the production build
// (`next build`, then `next start`), not only under `next dev`. Run by `pnpm verify` right after the
// build. It fails if:
// - the build prerendered an HTML page (a page built ahead of time has no per-response nonce, and the
//   policy would block its scripts: app/layout.tsx's `await connection()` prevents it);
// - a page is served without the policy, or with a script, script preload or stylesheet that does
//   not carry that response's nonce;
// - a path proxy.ts skips that can answer with a page (/favicon.ico, /_next/image) has no policy
//   that allows nothing (review L-30).
// No API or database is needed: pages are fetched signed out, as a browser would see them first.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { binPath, ROOT } from './lib/run.ts';

const WEB = join(ROOT, 'apps/web');
const PORT = 3197;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ID = '0196f3a2-7c41-7d2e-9b1a-3f2e4d5c6b7a';

const PAGES = [
  '/',
  '/sign-in',
  '/dashboard',
  '/live',
  `/sos/${ID}`,
  `/guards/${ID}/history`,
  `/sites/${ID}/print`,
  '/does-not-exist',
];
const NOTHING_PATHS = ['/favicon.ico', '/_next/image?url=%2Fbrand%2Fmissing.png&w=64&q=75'];

const problems: string[] = [];

function htmlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => join(entry.parentPath, entry.name));
}

function stop(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill('SIGTERM');
}

async function waitForServer(): Promise<void> {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    try {
      await fetch(`${ORIGIN}/sign-in`, { redirect: 'manual' });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error('next start did not answer within 60 s');
}

function checkPage(path: string, status: number, policy: string | null, html: string): void {
  const nonce = /script-src 'self' 'nonce-([A-Za-z0-9+/=]+)' 'strict-dynamic'/.exec(policy ?? '')?.[1];
  if (!nonce) {
    problems.push(`${path} (${status}): no Content-Security-Policy with a nonce`);
    return;
  }
  const scriptSrc = /(?:^|;\s*)script-src ([^;]*)/.exec(policy ?? '')?.[1] ?? '';
  if (/'unsafe-(eval|inline)'/.test(scriptSrc))
    problems.push(`${path}: script-src allows eval or inline code`);
  const tags = [
    ...html.matchAll(/<script\b[^>]*>/g),
    ...html.matchAll(/<link\b[^>]*\bas="script"[^>]*>/g),
    ...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g),
  ].map((m) => m[0]);
  if (!tags.some((tag) => tag.startsWith('<script')))
    problems.push(`${path}: no script at all (was the page read?)`);
  const without = tags.filter((tag) => !tag.includes(`nonce="${nonce}"`));
  for (const tag of without) problems.push(`${path}: without this response's nonce: ${tag.slice(0, 120)}`);
  console.log(`  ${path}  ${status}  ${tags.length} scripts and styles, ${without.length} without the nonce`);
}

// Next's built-in page for a crash of the root layout itself (there is no app/global-error.tsx). It
// is always prerendered, so its scripts carry no nonce and the policy blocks them: the error text,
// plain HTML, still shows; only its "try again" stops working. Known and accepted (Fable pass 2).
const PRERENDER_ALLOWED = new Set(['_global-error.html']);

// 1. Nothing prerendered.
const built = existsSync(join(WEB, '.next', 'BUILD_ID'));
if (!built) problems.push('no production build in apps/web/.next (run next build first)');
for (const file of htmlFiles(join(WEB, '.next', 'server', 'app'))) {
  const name = file.slice(join(WEB, '.next', 'server', 'app').length + 1).replaceAll('\\', '/');
  if (!PRERENDER_ALLOWED.has(name)) problems.push(`prerendered at build time, so without a nonce: ${name}`);
}

// 2. The pages, served by the production server.
if (built) {
  const server = spawn(
    process.execPath,
    [binPath('next'), 'start', '--hostname', '127.0.0.1', '--port', String(PORT)],
    {
      cwd: WEB,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        NEXT_TELEMETRY_DISABLED: '1',
        PHOTO_ORIGIN: 'https://sentryops-test-attachments.s3.ap-southeast-2.amazonaws.com',
      },
      stdio: 'ignore',
    },
  );
  try {
    await waitForServer();
    console.log('Production build, served by next start:');
    for (const path of PAGES) {
      const response = await fetch(`${ORIGIN}${path}`, { redirect: 'manual' });
      const type = response.headers.get('content-type') ?? '';
      if (!type.includes('text/html')) {
        // A redirect (signed out) carries the policy too; its target is checked as its own page.
        if (!response.headers.get('content-security-policy'))
          problems.push(`${path} (${response.status}): no policy`);
        console.log(`  ${path}  ${response.status}  ${type || 'no body'}, policy present`);
        continue;
      }
      checkPage(
        path,
        response.status,
        response.headers.get('content-security-policy'),
        await response.text(),
      );
    }
    for (const path of NOTHING_PATHS) {
      const response = await fetch(`${ORIGIN}${path}`, { redirect: 'manual' });
      const policy = response.headers.get('content-security-policy') ?? '';
      if (!/(^|;\s*)default-src 'none'/.test(policy) || !policy.includes("frame-ancestors 'none'")) {
        problems.push(`${path} (${response.status}): served without a policy that allows nothing`);
      } else {
        console.log(`  ${path}  ${response.status}  policy allows nothing`);
      }
    }
  } finally {
    stop(server);
  }
}

if (problems.length > 0) {
  console.error('\nThe production build breaks the Content-Security-Policy (SEC §10, review L-36):');
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exitCode = 1;
} else {
  console.log('Every page carries its own nonce; the skipped paths allow nothing.');
}
