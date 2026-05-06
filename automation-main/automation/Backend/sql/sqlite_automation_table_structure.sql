PRAGMA foreign_keys = ON;

-- =========================================================
-- SQLITE TABLE STRUCTURE FOR AUTOMATION SYSTEM
-- =========================================================
-- This file contains ONLY the table structure.
-- It includes comments to explain why each table exists
-- and how the tables are connected.
--
-- BUSINESS RULES INCLUDED:
-- 1. One company can have zero, one, or many entities.
-- 2. Some companies may not have entities.
-- 3. SFTP path can exist at company level or entity level.
-- 4. Current/in-progress process data stays in automation_runs.
-- 5. Completed process data moves to automation_history.
-- 6. Logs are stored separately for each run.
-- 7. User actions in the web app go to audit_logs.
-- 8. Path changes are tracked separately in sftp_path_history.
-- 9. Company processing can be ACTIVE / STOPPED / RELEASED / INACTIVE.
-- 10. History table keeps company_code, company_name, entity_code
--     so they are easy to show in UI/report even later.
-- =========================================================


-- =========================================================
-- 1. USERS
-- =========================================================
-- Stores application users.
-- Example roles: Admin, Operator
-- Passwords should be stored as password_hash, not plain text.
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name TEXT,
    role TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME
);


-- =========================================================
-- 2. COMPANY MASTER
-- =========================================================
-- Stores main company details.
-- One company can have many entities.
-- Some companies may have no entities.
--
-- IMPORTANT:
-- - company_code is business code like 'accelerate'
-- - sftp_path here is company-level default path
-- - status controls whether automation can run for this company
-- - is_active is for soft delete / active-in-system control
CREATE TABLE IF NOT EXISTS company_master (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_code TEXT NOT NULL UNIQUE,
    company_name TEXT NOT NULL,
    sftp_path TEXT,
    status TEXT DEFAULT 'ACTIVE',              -- ACTIVE / STOPPED / RELEASED / INACTIVE
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME,
    modified_by_user_id INTEGER,
    deleted_at DATETIME,
    deleted_by_user_id INTEGER,
    FOREIGN KEY (modified_by_user_id) REFERENCES users(id),
    FOREIGN KEY (deleted_by_user_id) REFERENCES users(id)
);


-- =========================================================
-- 3. ENTITY MASTER
-- =========================================================
-- Stores entity details under a company.
-- Each entity belongs to one company.
--
-- IMPORTANT:
-- - entity_code is business code like '001'
-- - sftp_path here is entity-level path
-- - if entity exists and has path, use this path for upload
-- - if no entity exists, use company_master.sftp_path
CREATE TABLE IF NOT EXISTS entity_master (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    entity_code TEXT NOT NULL UNIQUE,
    entity_name TEXT NOT NULL,
    sftp_path TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME,
    FOREIGN KEY (company_id) REFERENCES company_master(id)
);


-- =========================================================
-- 4. AUTOMATION RUNS
-- =========================================================
-- Stores ONLY current / in-progress / latest run data.
-- When trigger is pressed, one row is inserted here.
--
-- IMPORTANT:
-- - entity_id is nullable because some companies may not have entities
-- - sftp_path stores the actual path used during that run
-- - this table is for active process tracking
-- - after completion, data can be copied to automation_history
--   and then removed from this table if you want only live runs here
CREATE TABLE IF NOT EXISTS automation_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    entity_id INTEGER,
    triggered_by_user_id INTEGER,
    trigger_type TEXT,                        -- Manual / Scheduled
    period TEXT NOT NULL,                     -- Example: 2026-05
    sftp_path TEXT,                           -- snapshot of actual path used in this run
    hris_filepath TEXT,
    paysheet_filepath TEXT,
    hris_status TEXT DEFAULT 'Pending',
    paysheet_status TEXT DEFAULT 'Pending',
    overall_status TEXT DEFAULT 'Pending',
    started_at DATETIME,
    completed_at DATETIME,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME,
    FOREIGN KEY (company_id) REFERENCES company_master(id),
    FOREIGN KEY (entity_id) REFERENCES entity_master(id),
    FOREIGN KEY (triggered_by_user_id) REFERENCES users(id)
);


-- =========================================================
-- 5. AUTOMATION HISTORY
-- =========================================================
-- Stores completed / archived process data.
-- After run completion, final data should be copied from
-- automation_runs into automation_history.
--
-- IMPORTANT:
-- These snapshot columns are intentionally stored here:
-- - company_code
-- - company_name
-- - entity_code
--
-- Why?
-- So the UI/report can show them directly even if master data changes later.
--
-- entity_id is nullable because some runs may be company-only.
CREATE TABLE IF NOT EXISTS automation_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER,
    company_id INTEGER NOT NULL,
    entity_id INTEGER,
    company_code TEXT NOT NULL,
    company_name TEXT NOT NULL,
    entity_code TEXT,
    triggered_by_user_id INTEGER,
    trigger_type TEXT,
    period TEXT NOT NULL,
    sftp_path TEXT,                           -- snapshot of actual path used
    hris_filepath TEXT,
    paysheet_filepath TEXT,
    hris_status TEXT,
    paysheet_status TEXT,
    overall_status TEXT,
    started_at DATETIME,
    completed_at DATETIME,
    archived_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    error_message TEXT,
    FOREIGN KEY (run_id) REFERENCES automation_runs(id),
    FOREIGN KEY (company_id) REFERENCES company_master(id),
    FOREIGN KEY (entity_id) REFERENCES entity_master(id),
    FOREIGN KEY (triggered_by_user_id) REFERENCES users(id)
);


-- =========================================================
-- 6. AUTOMATION LOGS
-- =========================================================
-- Stores step-by-step logs for a run.
-- One run can have many log rows.
--
-- Example step_name:
-- - LOGIN
-- - DOWNLOAD_HRIS
-- - DOWNLOAD_PAYSHEET
-- - UPLOAD
-- - BACKUP
--
-- Example log_level:
-- - INFO
-- - WARN
-- - ERROR
CREATE TABLE IF NOT EXISTS automation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    log_level TEXT NOT NULL,
    step_name TEXT,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (run_id) REFERENCES automation_runs(id)
);


-- =========================================================
-- 7. AUDIT LOGS
-- =========================================================
-- Stores user activity in the web application.
--
-- Example actions:
-- - LOGIN
-- - CREATE
-- - UPDATE
-- - DELETE
-- - TRIGGER
-- - STOP_PROCESS
-- - RELEASE_PROCESS
--
-- target_table and target_id help identify what record was changed.
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    module_name TEXT,
    target_table TEXT,
    target_id INTEGER,
    details TEXT,
    performed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);


-- =========================================================
-- 8. BACKUP FILES
-- =========================================================
-- Stores backup information after each run.
--
-- Example backup_type:
-- - DB
-- - ZIP
-- - FILE
--
-- Example backup_status:
-- - Success
-- - Failed
-- - Pending
CREATE TABLE IF NOT EXISTS backup_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    backup_type TEXT,
    file_name TEXT,
    file_path TEXT,
    backup_status TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (run_id) REFERENCES automation_runs(id)
);


-- =========================================================
-- 9. APP SETTINGS
-- =========================================================
-- Stores application-level settings.
--
-- Example:
-- - download_folder
-- - backup_folder
-- - max_retries
-- - browser_name
CREATE TABLE IF NOT EXISTS app_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    setting_key TEXT NOT NULL UNIQUE,
    setting_value TEXT,
    updated_by_user_id INTEGER,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
);


-- =========================================================
-- 10. SFTP PATH HISTORY
-- =========================================================
-- Stores ONLY SFTP path changes.
--
-- Why separate table?
-- Because you wanted path tracking alone.
--
-- level_type tells whether the change happened at:
-- - COMPANY level
-- - ENTITY level
--
-- Example:
-- - company path changed from /sftp/bravo to /sftp/bravo/new
-- - entity path changed from /sftp/acc/001 to /sftp/acc/001_new
CREATE TABLE IF NOT EXISTS sftp_path_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER,
    entity_id INTEGER,
    level_type TEXT NOT NULL,                -- COMPANY / ENTITY
    old_path TEXT,
    new_path TEXT NOT NULL,
    changed_by_user_id INTEGER,
    changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    remarks TEXT,
    FOREIGN KEY (company_id) REFERENCES company_master(id),
    FOREIGN KEY (entity_id) REFERENCES entity_master(id),
    FOREIGN KEY (changed_by_user_id) REFERENCES users(id)
);


-- =========================================================
-- 11. COMPANY STATUS HISTORY
-- =========================================================
-- Stores stop/release/status changes for company processing.
--
-- Why needed?
-- Because some clients may be stopped and later released again.
--
-- Example statuses:
-- - ACTIVE
-- - STOPPED
-- - RELEASED
-- - INACTIVE
CREATE TABLE IF NOT EXISTS company_status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    old_status TEXT,
    new_status TEXT NOT NULL,
    changed_by_user_id INTEGER,
    changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    remarks TEXT,
    FOREIGN KEY (company_id) REFERENCES company_master(id),
    FOREIGN KEY (changed_by_user_id) REFERENCES users(id)
);


-- =========================================================
-- INDEXES
-- =========================================================
-- These indexes improve search/join speed on common columns.

CREATE INDEX IF NOT EXISTS idx_company_master_company_code
ON company_master(company_code);

CREATE INDEX IF NOT EXISTS idx_company_master_status
ON company_master(status);

CREATE INDEX IF NOT EXISTS idx_entity_master_company_id
ON entity_master(company_id);

CREATE INDEX IF NOT EXISTS idx_entity_master_entity_code
ON entity_master(entity_code);

CREATE INDEX IF NOT EXISTS idx_automation_runs_company_id
ON automation_runs(company_id);

CREATE INDEX IF NOT EXISTS idx_automation_runs_entity_id
ON automation_runs(entity_id);

CREATE INDEX IF NOT EXISTS idx_automation_runs_period
ON automation_runs(period);

CREATE INDEX IF NOT EXISTS idx_automation_history_run_id
ON automation_history(run_id);

CREATE INDEX IF NOT EXISTS idx_automation_history_company_id
ON automation_history(company_id);

CREATE INDEX IF NOT EXISTS idx_automation_history_entity_id
ON automation_history(entity_id);

CREATE INDEX IF NOT EXISTS idx_automation_history_period
ON automation_history(period);

CREATE INDEX IF NOT EXISTS idx_automation_logs_run_id
ON automation_logs(run_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id
ON audit_logs(user_id);

CREATE INDEX IF NOT EXISTS idx_backup_files_run_id
ON backup_files(run_id);

CREATE INDEX IF NOT EXISTS idx_sftp_path_history_company_id
ON sftp_path_history(company_id);

CREATE INDEX IF NOT EXISTS idx_sftp_path_history_entity_id
ON sftp_path_history(entity_id);

CREATE INDEX IF NOT EXISTS idx_company_status_history_company_id
ON company_status_history(company_id);
