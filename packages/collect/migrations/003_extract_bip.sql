-- Extraction progress per BIP: a run covers one BIP, and the next run for
-- that BIP starts after its own last document. A newly tracked BIP then
-- starts from the beginning of the archive instead of inheriting another
-- BIP's cursor. Every run before this migration was for BIP 352.

ALTER TABLE extract_runs ADD COLUMN bip integer;
UPDATE extract_runs SET bip = 352 WHERE bip IS NULL;
ALTER TABLE extract_runs ALTER COLUMN bip SET NOT NULL;

DROP INDEX IF EXISTS extract_runs_last_ok;
CREATE INDEX extract_runs_last_ok ON extract_runs (task, task_version, bip, finished_at DESC) WHERE ok AND NOT dry_run;
