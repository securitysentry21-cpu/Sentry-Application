-- Phase 10: the operator's replay of quarantined sync items (ARCH §9.3, runbook "Replaying quarantined
-- sync items"). A replay marks the item as replayed; nothing else about a quarantined item may ever
-- change, so the grant names the one column (the item, its device and its error stay as they were).
-- The table was registered as append-only; ARCH §6.1's append-only list never included it, and the
-- table has carried `replayed_at` since Phase 4 for exactly this.
grant update (replayed_at) on quarantined_items to app_runtime;
