// Owner decision Q5 (Fable pass 1, review L-13): in production only the owner runs a one-off task in
// the cell (infra/scripts/operator.sh, release.sh), from their own AWS login, with a reason. Running
// one needs ecs:RunTask and iam:PassRole; a task runs any command in the API's image with its
// secrets. So no role the cell creates (the services, CI's image role, the image builder, the
// replication role) may hold those rights, change what the services run, or open a shell in a
// container, and the cell creates no IAM user. Read from the Terraform itself: a mocked plan cannot
// show policy documents (tests/security.tftest.hcl mocks them).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const CELL = fileURLToPath(new URL('../../infra/terraform/cell/', import.meta.url));

/** Actions that run, change or enter a task, or hand a role to one. */
const FORBIDDEN =
  /^(\*|ecs:\*|ecs:(RunTask|StartTask|ExecuteCommand|RegisterTaskDefinition|UpdateService|CreateService)|iam:\*|iam:(PassRole|Create\w*|Attach\w*|Put\w*|Update\w*))$/;

/** AWS-managed policies the cell may attach, each read and found free of the actions above. */
const MANAGED_POLICIES = new Set([
  // ECR pull and log writing only, for the tasks' execution role.
  'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
]);

const files = readdirSync(CELL)
  .filter((name) => name.endsWith('.tf'))
  .map((name) => ({ name, text: readFileSync(join(CELL, name), 'utf8') }));

/** Every action an `actions = [...]` list or an `Action = ...` (string or list) names. */
function actionsIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/\b(?:actions|Action)\s*=\s*(\[[^\]]*\]|"[^"]*")/g)) {
    for (const token of (match[1] ?? '').matchAll(/"([^"]*)"/g)) found.push(token[1] ?? '');
  }
  return found;
}

describe('owner decision Q5: who may run a task in the cell', () => {
  it('no role the cell creates may run, change or enter a task, or pass a role (review L-13)', () => {
    const all = files.flatMap(({ name, text }) => actionsIn(text).map((action) => ({ name, action })));
    // The reader finds the cell's grants (so an empty result cannot pass by accident).
    expect(all.some((a) => a.action === 'ecr:PutImage')).toBe(true);
    expect(all.some((a) => a.action === 'secretsmanager:GetSecretValue')).toBe(true);
    expect(all.filter((a) => FORBIDDEN.test(a.action))).toEqual([]);
  });

  it('attaches no AWS-managed policy beyond the ones read, and creates no IAM user', () => {
    const attached = files.flatMap(({ text }) =>
      [...text.matchAll(/\bpolicy_arns?\s*=\s*"([^"]+)"/g)].map((m) => m[1] ?? ''),
    );
    expect(attached.length).toBeGreaterThan(0);
    expect(attached.filter((arn) => !MANAGED_POLICIES.has(arn))).toEqual([]);
    for (const { name, text } of files) {
      expect(text, `${name} creates an IAM user`).not.toMatch(/resource\s+"aws_iam_(user|access_key)"/);
      expect(text, `${name} attaches a list of managed policies`).not.toMatch(/managed_policy_arns/);
    }
  });
});
