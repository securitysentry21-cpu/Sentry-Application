// Membership change rules (SEC §6 rule 3, INV-03), as a pure function. The API calls it inside the
// transaction, after locking the organization's ACTIVE owner rows, so `actorIsActiveOwner` and
// `activeOwnerMemberIds` reflect committed state, not what the request context saw earlier.

export type MemberRole = 'OWNER' | 'ADMIN' | 'SUPERVISOR' | 'DISPATCHER' | 'GUARD';
export type MemberStatus = 'INVITED' | 'ACTIVE' | 'DISABLED' | 'REMOVED';

export type MemberChangeInput = {
  readonly actorUserId: string;
  /** The actor's own seat is among the locked ACTIVE owners (owners.manage is the owner's). */
  readonly actorIsActiveOwner: boolean;
  readonly target: {
    readonly memberId: string;
    readonly userId: string;
    readonly role: MemberRole;
    readonly status: MemberStatus;
    readonly version: number;
  };
  readonly change: { readonly role?: MemberRole; readonly status?: MemberStatus; readonly version: number };
  readonly activeOwnerMemberIds: readonly string[];
};

export type MemberChangeDecision =
  | { readonly ok: true; readonly role: MemberRole; readonly status: MemberStatus }
  | {
      readonly ok: false;
      readonly code: 'SELF_ROLE_CHANGE' | 'FORBIDDEN' | 'VERSION_CONFLICT' | 'LAST_OWNER';
    };

const PRIVILEGED: ReadonlySet<MemberRole> = new Set(['OWNER', 'ADMIN']);

/** Checked in this order: self, authority, version, last owner. */
export function decideMemberChange(input: MemberChangeInput): MemberChangeDecision {
  const { target, change } = input;
  const role = change.role ?? target.role;
  const status = change.status ?? target.status;
  if (target.userId === input.actorUserId) return { ok: false, code: 'SELF_ROLE_CHANGE' };
  if ((PRIVILEGED.has(target.role) || PRIVILEGED.has(role)) && !input.actorIsActiveOwner) {
    return { ok: false, code: 'FORBIDDEN' };
  }
  if (target.version !== change.version) return { ok: false, code: 'VERSION_CONFLICT' };
  const removesOwner =
    target.role === 'OWNER' && target.status === 'ACTIVE' && (role !== 'OWNER' || status !== 'ACTIVE');
  if (removesOwner && input.activeOwnerMemberIds.every((id) => id === target.memberId)) {
    return { ok: false, code: 'LAST_OWNER' };
  }
  return { ok: true, role, status };
}
