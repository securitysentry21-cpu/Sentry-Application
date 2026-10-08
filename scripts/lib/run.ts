// Runs tools through Node directly — no shell — so the scripts behave the same on Windows and in
// Linux CI, and no argument is ever re-parsed by a shell.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(join(ROOT, 'package.json'));

export type RunResult = { code: number; output: string };

/** Absolute path of a package's bin script, read from its package.json. */
export function binPath(pkg: string, bin = pkg): string {
  const manifestPath = require.resolve(`${pkg}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const rel = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[bin];
  if (!rel) throw new Error(`${pkg} has no bin named ${bin}`);
  return join(dirname(manifestPath), rel);
}

export function runNode(
  args: string[],
  options: { env?: Record<string, string | undefined>; cwd?: string; quiet?: boolean } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd ?? ROOT,
      // Colour codes break the output matching (negative controls). Vitest turns colour on when
      // FORCE_COLOR is set at all, on Windows and under CI; only NO_COLOR turns it off.
      env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: '1', ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (!options.quiet) process.stdout.write(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => resolve({ code: 1, output: `${output}\n${error.message}` }));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

/** Runs a package's bin, e.g. runBin('vitest', ['run']). */
export function runBin(
  pkg: string,
  args: string[],
  options: Parameters<typeof runNode>[1] & { bin?: string } = {},
): Promise<RunResult> {
  return runNode([binPath(pkg, options.bin), ...args], options);
}

/**
 * Vitest's exit code alone is not trusted: a dependency's exit hook once replaced it, and a run with
 * failing tests exited 0 (found by the negative controls, ADV-X02). A run counts as failed if the
 * code is non-zero OR its summary reports a failed test or file.
 */
export function vitestFailed(result: RunResult): boolean {
  return result.code !== 0 || /\b(?:Tests|Test Files)\s+\d+ failed\b/.test(result.output);
}

/** Runs pnpm itself. Works when the script was started through pnpm (npm_execpath is set). */
export function runPnpm(args: string[], options: Parameters<typeof runNode>[1] = {}): Promise<RunResult> {
  const pnpm = process.env.npm_execpath;
  if (!pnpm) return Promise.resolve({ code: 1, output: 'run this through pnpm (npm_execpath is not set)' });
  return runNode([pnpm, ...args], options);
}
