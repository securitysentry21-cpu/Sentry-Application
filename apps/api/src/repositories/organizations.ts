// Organizations and their settings overrides.
import type { Database } from '@sentryops/db';

export async function createOrganization(
  trx: Database,
  input: {
    id: string;
    name: string;
    legalName: string | null;
    timezone: string;
    dataRegion: string;
    settingsId: string;
    now: Date;
  },
): Promise<void> {
  await trx
    .insertInto('organizations')
    .values({
      id: input.id,
      name: input.name,
      legal_name: input.legalName,
      timezone: input.timezone,
      data_region: input.dataRegion,
      created_at: input.now,
      updated_at: input.now,
    })
    .execute();
  await trx
    .insertInto('organization_settings')
    .values({ id: input.settingsId, organization_id: input.id, overrides: '{}', updated_at: input.now })
    .execute();
}

export async function getOrganization(trx: Database, id: string) {
  return trx
    .selectFrom('organizations')
    .select(['id', 'name', 'status', 'timezone', 'default_locale', 'data_region'])
    .where('id', '=', id)
    .executeTakeFirst();
}

export async function getSettingsRow(trx: Database, organizationId: string) {
  return trx
    .selectFrom('organization_settings')
    .select(['id', 'overrides', 'version'])
    .where('organization_id', '=', organizationId)
    .executeTakeFirst();
}

export async function saveSettings(
  trx: Database,
  input: {
    organizationId: string;
    overrides: Record<string, unknown>;
    version: number;
    userId: string;
    now: Date;
  },
): Promise<boolean> {
  const result = await trx
    .updateTable('organization_settings')
    .set({
      overrides: JSON.stringify(input.overrides),
      version: input.version + 1,
      updated_by_user_id: input.userId,
      updated_at: input.now,
    })
    .where('organization_id', '=', input.organizationId)
    .where('version', '=', input.version)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}
