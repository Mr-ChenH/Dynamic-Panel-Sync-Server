-- Backup and restore state is management-plane data. Tenant request paths do
-- not access these tables; all current callers establish an explicit admin
-- actor for the duration of their transaction.
ALTER TABLE backup_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY backup_jobs_admin ON backup_jobs
  USING (operational_admin_allowed()) WITH CHECK (operational_admin_allowed());

ALTER TABLE restore_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE restore_stages FORCE ROW LEVEL SECURITY;
CREATE POLICY restore_stages_admin ON restore_stages
  USING (operational_admin_allowed()) WITH CHECK (operational_admin_allowed());

ALTER TABLE restore_stage_payloads ENABLE ROW LEVEL SECURITY;
ALTER TABLE restore_stage_payloads FORCE ROW LEVEL SECURITY;
CREATE POLICY restore_stage_payloads_admin ON restore_stage_payloads
  USING (operational_admin_allowed()) WITH CHECK (operational_admin_allowed());

ALTER TABLE restore_stage_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE restore_stage_objects FORCE ROW LEVEL SECURITY;
CREATE POLICY restore_stage_objects_admin ON restore_stage_objects
  USING (operational_admin_allowed()) WITH CHECK (operational_admin_allowed());

ALTER TABLE operational_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational_alerts FORCE ROW LEVEL SECURITY;
CREATE POLICY operational_alerts_admin ON operational_alerts
  USING (operational_admin_allowed()) WITH CHECK (operational_admin_allowed());
