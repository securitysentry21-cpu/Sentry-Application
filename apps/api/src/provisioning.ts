// Organization provisioning (D-19): the platform operator creates an organization in this cell and
// an invitation for its first owner. It runs as app_runtime inside the new organization's own
// tenant context, so RLS applies to provisioning like to everything else.
import { generateKeyPairSync } from 'node:crypto';

import { withTenantTransaction } from '@sentryops/db';

import type { AppDeps } from './deps.ts';
import { randomToken, uuidv7 } from './ids.ts';
import { recordAudit } from './repositories/audit.ts';
import { insertDevice, insertGuard } from './repositories/guards.ts';
import { createMemberInvitation } from './repositories/invitations.ts';
import { insertMember } from './repositories/memberships.ts';
import { createOrganization } from './repositories/organizations.ts';
import { createUser, findUserByEmail } from './repositories/users.ts';
import { acceptUrl } from './routes/invitations.ts';

export type ProvisionInput = {
  readonly name: string;
  readonly legalName?: string | null;
  readonly timezone: string;
  readonly ownerEmail: string;
  /** DEMO: store reviewers' organization, no real people; every SOS a drill (PROD §17). */
  readonly kind?: 'CUSTOMER' | 'DEMO';
};

export async function provisionOrganization(
  deps: AppDeps,
  input: ProvisionInput,
): Promise<{ organizationId: string; invitationId: string; acceptUrl: string }> {
  if (!Intl.supportedValuesOf('timeZone').includes(input.timezone)) {
    throw new Error(`unknown timezone: ${input.timezone}`);
  }
  const organizationId = uuidv7(deps.clock);
  const invitationId = uuidv7(deps.clock);
  const token = randomToken(32);
  const now = deps.clock.now();
  const operator = {
    type: 'PLATFORM_OPERATOR' as const,
    userId: null,
    requestId: null,
    ip: null,
    userAgent: 'operator-cli',
  };
  await withTenantTransaction(deps.db, organizationId, async (trx) => {
    await createOrganization(trx, {
      id: organizationId,
      name: input.name,
      legalName: input.legalName ?? null,
      timezone: input.timezone,
      dataRegion: deps.config.CELL_REGION,
      settingsId: uuidv7(deps.clock),
      now,
      kind: input.kind ?? 'CUSTOMER',
    });
    await createMemberInvitation(trx, {
      id: invitationId,
      organizationId,
      email: input.ownerEmail,
      role: 'OWNER',
      token,
      createdByUserId: null,
      now,
    });
    await recordAudit(trx, deps.clock, organizationId, operator, {
      action: 'ORGANIZATION_CREATED',
      resourceType: 'organization',
      resourceId: organizationId,
      metadata: { dataRegion: deps.config.CELL_REGION },
    });
    await recordAudit(trx, deps.clock, organizationId, operator, {
      action: 'MEMBER_INVITED',
      resourceType: 'invitation',
      resourceId: invitationId,
      metadata: { role: 'OWNER' },
    });
  });
  return { organizationId, invitationId, acceptUrl: acceptUrl(deps.config.PUBLIC_ORIGIN, token) };
}

/**
 * The synthetic canary's organization (ARCH §18.4): kind CANARY, so every SOS in it is a drill that
 * reaches only its own members. It gets an ACTIVE administrator (the operator's internal address,
 * whose browser may subscribe as the "internal test device"), one guard and one phone whose key pair is
 * made here; the private key is printed once, for the worker's secret, and kept nowhere else.
 */
export async function provisionCanary(
  deps: AppDeps,
  input: { readonly ownerEmail: string },
): Promise<{ organizationId: string; deviceId: string; privateKey: string }> {
  const organizationId = uuidv7(deps.clock);
  const deviceId = uuidv7(deps.clock);
  const guardId = uuidv7(deps.clock);
  const now = deps.clock.now();
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const existing = await findUserByEmail(deps.db, input.ownerEmail);
  const user =
    existing ??
    (await createUser(deps.db, {
      id: uuidv7(deps.clock),
      email: input.ownerEmail,
      name: 'Canary operator',
      subject: null,
      now,
    }));
  const operator = {
    type: 'PLATFORM_OPERATOR' as const,
    userId: null,
    requestId: null,
    ip: null,
    userAgent: 'operator-cli',
  };
  await withTenantTransaction(deps.db, organizationId, async (trx) => {
    await createOrganization(trx, {
      id: organizationId,
      name: 'SENTRY canary',
      legalName: null,
      timezone: 'UTC',
      dataRegion: deps.config.CELL_REGION,
      settingsId: uuidv7(deps.clock),
      now,
      kind: 'CANARY',
    });
    // An administrator: the ladder's first step reaches administrators, so the canary's push check
    // runs within seconds (an owner is reached only at 180 s).
    await insertMember(trx, { id: uuidv7(deps.clock), organizationId, userId: user.id, role: 'ADMIN', now });
    await insertGuard(trx, {
      id: guardId,
      organizationId,
      userId: user.id,
      employeeNumber: 'CANARY-1',
      displayName: 'Canary guard',
      phone: '+10000000000',
      preferredLocale: 'en',
      now,
    });
    await insertDevice(trx, {
      id: deviceId,
      organizationId,
      guardId,
      installationId: uuidv7(deps.clock),
      publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }),
      platform: 'ANDROID',
      manufacturer: 'SENTRY',
      model: 'canary',
      osVersion: '0',
      appVersion: '0.0.0',
      now,
    });
    await recordAudit(trx, deps.clock, organizationId, operator, {
      action: 'ORGANIZATION_CREATED',
      resourceType: 'organization',
      resourceId: organizationId,
      metadata: { dataRegion: deps.config.CELL_REGION, kind: 'CANARY' },
    });
  });
  return {
    organizationId,
    deviceId,
    privateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}
