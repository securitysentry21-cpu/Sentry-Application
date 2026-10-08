// Organization provisioning (D-19): the platform operator creates an organization in this cell and
// an invitation for its first owner. It runs as app_runtime inside the new organization's own
// tenant context, so RLS applies to provisioning like to everything else.
import { withTenantTransaction } from '@sentryops/db';

import type { AppDeps } from './deps.ts';
import { randomToken, uuidv7 } from './ids.ts';
import { recordAudit } from './repositories/audit.ts';
import { createMemberInvitation } from './repositories/invitations.ts';
import { createOrganization } from './repositories/organizations.ts';
import { acceptUrl } from './routes/invitations.ts';

export type ProvisionInput = {
  readonly name: string;
  readonly legalName?: string | null;
  readonly timezone: string;
  readonly ownerEmail: string;
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
