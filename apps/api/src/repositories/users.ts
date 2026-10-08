// Users are global within a cell (ARCH §6.3, registry reason). Looked up by ID, email or provider
// subject only — there is no listing function, by design (SEC §4.5).
import type { Database } from '@sentryops/db';

export type User = {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly status: 'ACTIVE' | 'DISABLED';
  readonly locale: string;
  readonly authProviderUserId: string | null;
};

const columns = ['id', 'name', 'email', 'status', 'locale', 'auth_provider_user_id'] as const;

function toUser(row: {
  id: string;
  name: string;
  email: string | null;
  status: string;
  locale: string;
  auth_provider_user_id: string | null;
}): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    status: row.status === 'ACTIVE' ? 'ACTIVE' : 'DISABLED',
    locale: row.locale,
    authProviderUserId: row.auth_provider_user_id,
  };
}

export async function findUserById(db: Database, id: string): Promise<User | null> {
  const row = await db.selectFrom('users').select(columns).where('id', '=', id).executeTakeFirst();
  return row ? toUser(row) : null;
}

export async function findUserByEmail(db: Database, email: string): Promise<User | null> {
  const row = await db
    .selectFrom('users')
    .select(columns)
    .where('email', '=', email.toLowerCase())
    .executeTakeFirst();
  return row ? toUser(row) : null;
}

export async function findUserBySubject(db: Database, subject: string): Promise<User | null> {
  const row = await db
    .selectFrom('users')
    .select(columns)
    .where('auth_provider_user_id', '=', subject)
    .executeTakeFirst();
  return row ? toUser(row) : null;
}

export async function createUser(
  db: Database,
  input: { id: string; email: string; name: string; subject: string | null; now: Date },
): Promise<User> {
  const row = await db
    .insertInto('users')
    .values({
      id: input.id,
      email: input.email.toLowerCase(),
      name: input.name,
      auth_provider_user_id: input.subject,
      created_at: input.now,
      updated_at: input.now,
    })
    .returning(columns)
    .executeTakeFirstOrThrow();
  return toUser(row);
}

/** Links an existing user (found by verified email) to the provider subject on first sign-in. */
export async function linkSubject(db: Database, userId: string, subject: string, now: Date): Promise<void> {
  await db
    .updateTable('users')
    .set({ auth_provider_user_id: subject, updated_at: now })
    .where('id', '=', userId)
    .where('auth_provider_user_id', 'is', null)
    .execute();
}
