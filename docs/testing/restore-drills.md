# Restore drills (ARCH §19.6)

ARCH §19.6 asks for a restore drill before launch and every quarter, with targets of RPO ≤ 15 minutes and RTO ≤ 4 hours. `infra/scripts/restore-drill.sh <environment>` runs one (`infra/README.md` › Restore drill). Record every drill here, failed ones included.

| Date       | Environment   | Restored to                              | Data loss window             | Time to a usable copy                                       | Checked after | Check  | Copy deleted   |
| ---------- | ------------- | ---------------------------------------- | ---------------------------- | ----------------------------------------------------------- | ------------- | ------ | -------------- |
| 2026-11-02 | test (Sydney) | 17:26:34 UTC, the latest restorable time | 6 min before the drill began | about 9 min (restored and restarted); 26 min to "available" | 28 min 29 s   | passed | yes, 18:03 UTC |

## 2026-11-02, test

- **Image:** `8854af8` (Phase 9), the database at migration 0011. The image predates the check, so the drill sent the check with the task (`RESTORE_CHECK_FROM_CHECKOUT=1`).
- **What the check found on the copy:**
  - all 11 migrations recorded, with their files' checksums;
  - the schema linter (ADV-X01) found nothing;
  - `app_runtime`, `system_worker` and `retention_worker` each passed the startup role check (ADV-X07);
  - every registered table was counted.
- **What it proves:** the procedure, the tooling, and that backups restore into a private, encrypted copy with the same network, parameters and certificate authority, holding a schema with every security mechanism in place.
- **What it doesn't prove:**
  - **Restore time at scale.** The test environment holds almost no data (one organization, one member, four audit entries).
  - **Switching the services over to a restored copy,** which a real restore also needs.
  - **The cross-region backup copy.** Test has none; production copies its backups to Ireland (ARCH §19.8).
  - The drill before launch runs on production.
- **Timing:**
  - RDS reported the copy restored and restarted about 9 minutes after the request, and it accepts connections from then on.
  - It then took about 16 more minutes to back up the copy itself before reporting "available", which the script waits for. So "available after 26 minutes" overstates the time to a usable copy.
