import { describe, expect, it } from 'vitest';

import { decideMemberChange, type MemberChangeInput } from '../src/members.ts';

const OWNER_SEAT = 'seat-owner';
const base = (overrides: Partial<MemberChangeInput> = {}): MemberChangeInput => ({
  actorUserId: 'actor',
  actorIsActiveOwner: true,
  target: { memberId: OWNER_SEAT, userId: 'target', role: 'OWNER', status: 'ACTIVE', version: 3 },
  change: { role: 'ADMIN', version: 3 },
  activeOwnerMemberIds: [OWNER_SEAT, 'seat-actor'],
  ...overrides,
});

describe('membership change rules (SEC §6 rule 3)', () => {
  it('ADV-A02 a change to your own seat is refused before anything else', () => {
    expect(decideMemberChange(base({ actorUserId: 'target' }))).toEqual({
      ok: false,
      code: 'SELF_ROLE_CHANGE',
    });
  });

  it('ADV-A05 only an active owner may touch owners or administrators, or grant those roles', () => {
    const notOwner = { actorIsActiveOwner: false };
    expect(decideMemberChange(base(notOwner)).ok).toBe(false);
    const admin = {
      memberId: 's',
      userId: 't',
      role: 'ADMIN' as const,
      status: 'ACTIVE' as const,
      version: 1,
    };
    expect(
      decideMemberChange(base({ ...notOwner, target: admin, change: { status: 'DISABLED', version: 1 } })),
    ).toEqual({ ok: false, code: 'FORBIDDEN' });
    const sup = { ...admin, role: 'SUPERVISOR' as const };
    expect(
      decideMemberChange(base({ ...notOwner, target: sup, change: { role: 'ADMIN', version: 1 } })),
    ).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(
      decideMemberChange(base({ ...notOwner, target: sup, change: { role: 'DISPATCHER', version: 1 } })),
    ).toEqual({ ok: true, role: 'DISPATCHER', status: 'ACTIVE' });
  });

  it('a stale version is refused', () => {
    expect(decideMemberChange(base({ change: { role: 'ADMIN', version: 2 } }))).toEqual({
      ok: false,
      code: 'VERSION_CONFLICT',
    });
  });

  it('ADV-A06 the last active owner cannot be demoted, disabled or removed', () => {
    const last = { activeOwnerMemberIds: [OWNER_SEAT] };
    for (const change of [
      { role: 'ADMIN' as const, version: 3 },
      { status: 'DISABLED' as const, version: 3 },
      { status: 'REMOVED' as const, version: 3 },
    ]) {
      expect(decideMemberChange(base({ ...last, change }))).toEqual({ ok: false, code: 'LAST_OWNER' });
    }
    // With another active owner the same change is allowed.
    expect(decideMemberChange(base()).ok).toBe(true);
    // Promoting someone to owner never trips the rule.
    const sup = {
      memberId: 's',
      userId: 't',
      role: 'SUPERVISOR' as const,
      status: 'ACTIVE' as const,
      version: 1,
    };
    expect(decideMemberChange(base({ ...last, target: sup, change: { role: 'OWNER', version: 1 } })).ok).toBe(
      true,
    );
  });
});
