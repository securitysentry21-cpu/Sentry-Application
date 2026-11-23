// Review L-22, approved by the owner 2026-11-23: Terraform's state holds every generated secret, so
// its bucket is encrypted with a key of our own, rotated every year, and Terraform names that key on
// every write. infra/scripts/bootstrap-state.sh is run against a stand-in AWS CLI and Terraform that
// record what they are asked; no AWS account is touched.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../infra/scripts/bootstrap-state.sh', import.meta.url));
const KEY = 'arn:aws:kms:ap-southeast-2:111122223333:key/0b1c2d3e-0000-4000-8000-000000000000';

/** Bash on Windows (Git Bash) takes forward slashes. */
const posix = (path: string) => path.replaceAll('\\', '/');

const STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$STUB_LOG"
case "$1 $2" in
  "sts get-caller-identity") echo 111122223333 ;;
  "kms describe-key") [ "$STUB_KEY_EXISTS" = 1 ] && echo "$STUB_KEY" || { echo "NotFoundException" >&2; exit 254; } ;;
  "kms create-key") echo "$STUB_KEY" ;;
esac
exit 0
`;

let dir = '';
let log = '';

function bootstrap(keyExists: boolean): { calls: string[]; backend: string } {
  writeFileSync(log, '');
  execFileSync('bash', [posix(SCRIPT), 'test'], {
    env: {
      ...process.env,
      AWS: posix(join(dir, 'aws')),
      TERRAFORM: posix(join(dir, 'aws')),
      BACKEND_DIR: posix(dir),
      STUB_LOG: posix(log),
      STUB_KEY: KEY,
      STUB_KEY_EXISTS: keyExists ? '1' : '0',
    },
    stdio: 'pipe',
  });
  return {
    calls: readFileSync(log, 'utf8').trim().split('\n'),
    backend: readFileSync(join(dir, 'test.backend.hcl'), 'utf8'),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bootstrap-state-'));
  log = join(dir, 'calls.log');
  writeFileSync(join(dir, 'aws'), STUB);
  chmodSync(join(dir, 'aws'), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('review L-22: the Terraform state is encrypted with a key of our own', () => {
  it('a new environment gets its own rotated key, the bucket defaults to it, and Terraform names it on every write', () => {
    const { calls, backend } = bootstrap(false);

    expect(calls.some((c) => c.startsWith('kms create-key'))).toBe(true);
    expect(calls).toContain(
      `kms create-alias --region ap-southeast-2 --alias-name alias/sentryops-test-tfstate --target-key-id ${KEY}`,
    );
    expect(calls).toContain(`kms enable-key-rotation --region ap-southeast-2 --key-id ${KEY}`);

    const encryption = calls.find((c) => c.startsWith('s3api put-bucket-encryption'));
    expect(encryption).toContain('--bucket sentryops-test-tfstate-111122223333');
    expect(encryption).toContain('"SSEAlgorithm":"aws:kms"');
    expect(encryption).toContain(`"KMSMasterKeyID":"${KEY}"`);
    expect(encryption).not.toContain('AES256');

    expect(backend).toMatch(/^encrypt\s*=\s*true$/m);
    expect(backend).toMatch(new RegExp(`^kms_key_id\\s*=\\s*"${KEY}"$`, 'm'));
    expect(calls.some((c) => c.includes('init') && c.includes('test.backend.hcl'))).toBe(true);
  });

  it('run again, it keeps the existing key, turns rotation on and points the bucket at it', () => {
    const { calls, backend } = bootstrap(true);

    expect(calls.some((c) => c.startsWith('kms create-key'))).toBe(false);
    expect(calls.some((c) => c.startsWith('kms create-alias'))).toBe(false);
    expect(calls).toContain(`kms enable-key-rotation --region ap-southeast-2 --key-id ${KEY}`);
    expect(calls.find((c) => c.startsWith('s3api put-bucket-encryption'))).toContain(
      `"KMSMasterKeyID":"${KEY}"`,
    );
    expect(backend).toMatch(new RegExp(`^kms_key_id\\s*=\\s*"${KEY}"$`, 'm'));
  });
});
