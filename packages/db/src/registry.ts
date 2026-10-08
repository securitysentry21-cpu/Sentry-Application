// Table registry: every table in the database is classified here, and the schema linter (ADV-X01)
// fails on any table that is not, or that breaks the rules for its kind.

export type TableKind =
  /** The organizations table itself: its own id is the tenant. */
  | 'tenant-root'
  /** Tenant data: organization_id, RLS, policies, composite keys (ARCH §4.3–§4.4, INV-13). */
  | 'tenant'
  /** Tenant data the runtime role may only insert and read (ARCH §6.1, INV-05). */
  | 'tenant-append-only'
  /** Cross-tenant by design, e.g. users. Needs a recorded reason (SEC §4.2). */
  | 'global'
  /** Bookkeeping with no tenant data. Needs a recorded reason; runtime roles get no write access. */
  | 'internal';

export type TableEntry = { readonly kind: TableKind; readonly reason?: string };
export type TableRegistry = Readonly<Record<string, TableEntry>>;

const TENANT_KINDS: ReadonlySet<TableKind> = new Set(['tenant-root', 'tenant', 'tenant-append-only']);

/** True for the kinds that hold one organization's data. */
export const isTenantKind = (kind: TableKind): boolean => TENANT_KINDS.has(kind);

/**
 * The tables that hold tenant data. Generated tests (ADV-T06) iterate over this, so a new tenant
 * table is covered as soon as it is registered, and the schema linter forces registration.
 */
export function tenantTables(registry: TableRegistry): string[] {
  return Object.entries(registry)
    .filter(([, entry]) => isTenantKind(entry.kind))
    .map(([name]) => name)
    .sort();
}

export const TABLES: TableRegistry = {
  organizations: { kind: 'tenant-root' },
  schema_migrations: { kind: 'internal', reason: 'migration bookkeeping; holds no tenant data' },
};
