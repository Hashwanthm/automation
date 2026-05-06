const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3-offline-next');

const dataDir = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const legacyDbPath = path.join(dataDir, 'automation.db');
const dbPath = path.join(dataDir, 'main.db');
if (!fs.existsSync(dbPath) && fs.existsSync(legacyDbPath)) {
  fs.renameSync(legacyDbPath, dbPath);
}

const db = new sqlite3.Database(dbPath);
db.dbPath = dbPath;
db.dataDir = dataDir;

function createCompatibilityTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT,
      client_name TEXT,
      client_code TEXT,
      entity_code TEXT,
      sftp_path TEXT,
      month TEXT,
      period TEXT,
      common TEXT,
      file_path TEXT,
      hrisFilePath TEXT,
      paysheetFilePath TEXT,
      status TEXT DEFAULT 'Pending',
      uploadStatus TEXT DEFAULT 'Pending',
      client_status TEXT DEFAULT 'ACTIVE',
      modified_by TEXT DEFAULT 'System',
      updated_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    ALTER TABLE clients ADD COLUMN client_status TEXT DEFAULT 'ACTIVE'
  `, (err) => {
    if (err && !String(err.message).toLowerCase().includes('duplicate column')) {
      console.warn('Could not add client_status column:', err.message);
    }
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_ref_id INTEGER,
      client_id TEXT,
      client_code TEXT,
      entity_code TEXT,
      sftp_path TEXT,
      month TEXT,
      period TEXT,
      common TEXT,
      file_path TEXT,
      hrisFilePath TEXT,
      paysheetFilePath TEXT,
      status TEXT DEFAULT 'Pending',
      uploadStatus TEXT DEFAULT 'Pending',
      modified_by TEXT DEFAULT 'System',
      updated_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS current_process (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      source_client_id INTEGER,
      client_name TEXT,
      client_code TEXT,
      entity_code TEXT,
      month TEXT,
      period TEXT,
      common TEXT,
      file_path TEXT,
      hrisFilePath TEXT,
      paysheetFilePath TEXT,
      status TEXT DEFAULT 'Pending',
      uploadStatus TEXT DEFAULT 'Pending',
      run_status TEXT,
      created_at DATETIME,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_entities_client_entity_period ON entities (client_ref_id, entity_code, period)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_current_process_run_id ON current_process (run_id)`);
}

function createRequestedTables() {
  db.run(`PRAGMA foreign_keys = ON`);

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      role TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS company_master (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_code TEXT NOT NULL UNIQUE,
      company_name TEXT NOT NULL,
      sftp_path TEXT,
      status TEXT DEFAULT 'ACTIVE',
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME,
      modified_by_user_id INTEGER,
      deleted_at DATETIME,
      deleted_by_user_id INTEGER,
      FOREIGN KEY (modified_by_user_id) REFERENCES users(id),
      FOREIGN KEY (deleted_by_user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS entity_master (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      entity_code TEXT NOT NULL,
      entity_name TEXT NOT NULL,
      sftp_path TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME,
      FOREIGN KEY (company_id) REFERENCES company_master(id),
      UNIQUE(company_id, entity_code)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS automation_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_run_id TEXT,
      company_id INTEGER NOT NULL,
      entity_id INTEGER,
      triggered_by_user_id INTEGER,
      trigger_type TEXT,
      period TEXT NOT NULL,
      sftp_path TEXT,
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
      company_code TEXT,
      company_name TEXT,
      entity_code TEXT,
      run_status TEXT,
      common TEXT,
      file_path TEXT,
      source_entity_row_id INTEGER,
      FOREIGN KEY (company_id) REFERENCES company_master(id),
      FOREIGN KEY (entity_id) REFERENCES entity_master(id),
      FOREIGN KEY (triggered_by_user_id) REFERENCES users(id),
      UNIQUE(company_id, entity_id, period)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS automation_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      company_id INTEGER,
      entity_id INTEGER,
      company_code TEXT,
      company_name TEXT,
      entity_code TEXT,
      triggered_by_user_id INTEGER,
      trigger_type TEXT,
      period TEXT,
      sftp_path TEXT,
      hris_filepath TEXT,
      paysheet_filepath TEXT,
      hris_status TEXT,
      paysheet_status TEXT,
      overall_status TEXT,
      started_at DATETIME,
      completed_at DATETIME,
      archived_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      error_message TEXT,
      source_client_id INTEGER,
      month TEXT,
      common TEXT,
      file_path TEXT,
      hrisFilePath TEXT,
      paysheetFilePath TEXT,
      status TEXT DEFAULT 'Pending',
      uploadStatus TEXT DEFAULT 'Pending',
      run_status TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (company_id) REFERENCES company_master(id),
      FOREIGN KEY (entity_id) REFERENCES entity_master(id),
      FOREIGN KEY (triggered_by_user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS automation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      log_level TEXT,
      step_name TEXT,
      message TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      level TEXT DEFAULT 'info',
      event_type TEXT,
      client_id TEXT,
      client_name TEXT,
      entity_code TEXT,
      month TEXT,
      period TEXT,
      common TEXT,
      details TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      module_name TEXT,
      target_table TEXT,
      target_id INTEGER,
      details TEXT,
      performed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      target TEXT,
      label TEXT,
      value TEXT,
      page TEXT,
      section TEXT,
      path TEXT,
      period TEXT,
      common TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS backup_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER,
      backup_type TEXT,
      file_name TEXT,
      file_path TEXT,
      backup_status TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (run_id) REFERENCES automation_runs(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      setting_key TEXT NOT NULL UNIQUE,
      setting_value TEXT,
      updated_by_user_id INTEGER,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      period TEXT,
      common TEXT,
      FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sftp_path_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER,
      entity_id INTEGER,
      level_type TEXT NOT NULL,
      old_path TEXT,
      new_path TEXT NOT NULL,
      changed_by_user_id INTEGER,
      changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      remarks TEXT,
      FOREIGN KEY (company_id) REFERENCES company_master(id),
      FOREIGN KEY (entity_id) REFERENCES entity_master(id),
      FOREIGN KEY (changed_by_user_id) REFERENCES users(id)
    )
  `);

  db.run(`
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
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_company_master_company_code ON company_master(company_code)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_company_master_status ON company_master(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_entity_master_company_id ON entity_master(company_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_entity_master_entity_code ON entity_master(entity_code)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_automation_runs_company_id ON automation_runs(company_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_automation_runs_entity_id ON automation_runs(entity_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_automation_runs_period ON automation_runs(period)`);

  db.run(`ALTER TABLE automation_runs ADD COLUMN upload_status TEXT DEFAULT 'Pending'`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      console.warn('Could not add upload_status column:', err.message);
    }
  });
  db.run(`ALTER TABLE automation_runs ADD COLUMN last_step TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      console.warn('Could not add last_step column:', err.message);
    }
  });
  db.run(`CREATE INDEX IF NOT EXISTS idx_automation_runs_external_run_id ON automation_runs(external_run_id)`);

  // Add missing columns to automation_history table (migration)
  db.run(`ALTER TABLE automation_history ADD COLUMN client_name TEXT`, (err) => {
    if (err && !err.message.includes("duplicate column")) {
      console.warn("Could not add client_name column:", err.message);
    }
  });
  db.run(`ALTER TABLE automation_history ADD COLUMN client_code TEXT`, (err) => {
    if (err && !err.message.includes("duplicate column")) {
      console.warn("Could not add client_code column:", err.message);
    }
  });


  db.run(`
    CREATE TABLE IF NOT EXISTS stop_process (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      entity_code TEXT,
      done_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (company_id) REFERENCES company_master(id)
    )
  `);

  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_stop_process_company_entity_unique ON stop_process(company_id, entity_code)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_stop_process_company_id ON stop_process(company_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_stop_process_entity_code ON stop_process(entity_code)`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_automation_history_run_id ON automation_history(run_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_automation_history_company_id ON automation_history(company_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_automation_history_entity_id ON automation_history(entity_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_automation_history_period ON automation_history(period)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_automation_logs_run_id ON automation_logs(run_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_backup_files_run_id ON backup_files(run_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sftp_path_history_company_id ON sftp_path_history(company_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sftp_path_history_entity_id ON sftp_path_history(entity_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_company_status_history_company_id ON company_status_history(company_id)`);
}

function createSyncTriggers() {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_clients_ai_company_master;
    DROP TRIGGER IF EXISTS trg_clients_au_company_master;
    DROP TRIGGER IF EXISTS trg_clients_ad_company_master;
    DROP TRIGGER IF EXISTS trg_entities_ai_entity_master;
    DROP TRIGGER IF EXISTS trg_entities_au_entity_master;
    DROP TRIGGER IF EXISTS trg_entities_ad_entity_master;
    DROP TRIGGER IF EXISTS trg_current_process_ai_runs;
    DROP TRIGGER IF EXISTS trg_current_process_au_runs;
    DROP TRIGGER IF EXISTS trg_history_ai_snapshot;
    DROP TRIGGER IF EXISTS trg_history_au_snapshot;
    DROP TRIGGER IF EXISTS trg_logs_ai_sync;
    DROP TRIGGER IF EXISTS trg_logs_au_sync;
    DROP TRIGGER IF EXISTS trg_audit_ai_sync;
    DROP TRIGGER IF EXISTS trg_audit_au_sync;
    DROP TRIGGER IF EXISTS trg_settings_ai_sync;
    DROP TRIGGER IF EXISTS trg_settings_au_sync;

    CREATE TRIGGER trg_clients_ai_company_master
    AFTER INSERT ON clients
    BEGIN
      INSERT INTO company_master (company_code, company_name, sftp_path, status, is_active, created_at, updated_at)
      VALUES (
        COALESCE(NULLIF(NEW.client_id, ''), NEW.client_code),
        COALESCE(NULLIF(NEW.client_name, ''), COALESCE(NULLIF(NEW.client_id, ''), NEW.client_code)),
        COALESCE(NULLIF(NEW.sftp_path, ''), NEW.file_path),
        CASE WHEN UPPER(COALESCE(NEW.status, '')) IN ('ACTIVE', 'STOPPED', 'RELEASED', 'INACTIVE') THEN UPPER(NEW.status) ELSE 'ACTIVE' END,
        1,
        COALESCE(NEW.created_at, CURRENT_TIMESTAMP),
        COALESCE(NEW.updated_at, CURRENT_TIMESTAMP)
      )
      ON CONFLICT(company_code) DO UPDATE SET
        company_name = excluded.company_name,
        sftp_path = COALESCE(excluded.sftp_path, company_master.sftp_path),
        updated_at = CURRENT_TIMESTAMP,
        is_active = 1;
    END;

    CREATE TRIGGER trg_clients_au_company_master
    AFTER UPDATE ON clients
    BEGIN
      INSERT INTO company_master (company_code, company_name, sftp_path, status, is_active, created_at, updated_at)
      VALUES (
        COALESCE(NULLIF(NEW.client_id, ''), NEW.client_code),
        COALESCE(NULLIF(NEW.client_name, ''), COALESCE(NULLIF(NEW.client_id, ''), NEW.client_code)),
        COALESCE(NULLIF(NEW.sftp_path, ''), NEW.file_path),
        CASE WHEN UPPER(COALESCE(NEW.status, '')) IN ('ACTIVE', 'STOPPED', 'RELEASED', 'INACTIVE') THEN UPPER(NEW.status) ELSE 'ACTIVE' END,
        1,
        COALESCE(NEW.created_at, CURRENT_TIMESTAMP),
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(company_code) DO UPDATE SET
        company_name = excluded.company_name,
        sftp_path = COALESCE(excluded.sftp_path, company_master.sftp_path),
        updated_at = CURRENT_TIMESTAMP,
        is_active = 1;

      INSERT INTO sftp_path_history (company_id, level_type, old_path, new_path, remarks)
      SELECT cm.id, 'COMPANY', COALESCE(NULLIF(OLD.sftp_path, ''), OLD.file_path), COALESCE(NULLIF(NEW.sftp_path, ''), NEW.file_path), 'Synced from clients table'
      FROM company_master cm
      WHERE cm.company_code = COALESCE(NULLIF(NEW.client_id, ''), NEW.client_code)
        AND COALESCE(NULLIF(OLD.sftp_path, ''), OLD.file_path, '') <> COALESCE(NULLIF(NEW.sftp_path, ''), NEW.file_path, '')
        AND COALESCE(NULLIF(NEW.sftp_path, ''), NEW.file_path, '') <> '';

      INSERT INTO company_status_history (company_id, old_status, new_status, remarks)
      SELECT cm.id,
             CASE WHEN UPPER(COALESCE(OLD.status, '')) IN ('ACTIVE', 'STOPPED', 'RELEASED', 'INACTIVE') THEN UPPER(OLD.status) ELSE 'ACTIVE' END,
             UPPER(NEW.status),
             'Synced from clients table'
      FROM company_master cm
      WHERE cm.company_code = COALESCE(NULLIF(NEW.client_id, ''), NEW.client_code)
        AND UPPER(COALESCE(OLD.status, '')) <> UPPER(COALESCE(NEW.status, ''))
        AND UPPER(COALESCE(NEW.status, '')) IN ('ACTIVE', 'STOPPED', 'RELEASED', 'INACTIVE');
    END;

    CREATE TRIGGER trg_clients_ad_company_master
    AFTER DELETE ON clients
    BEGIN
      UPDATE company_master
      SET is_active = 0,
          deleted_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE company_code = COALESCE(NULLIF(OLD.client_id, ''), OLD.client_code);
    END;

    CREATE TRIGGER trg_entities_ai_entity_master
    AFTER INSERT ON entities
    BEGIN
      INSERT INTO company_master (company_code, company_name, sftp_path, status, is_active, created_at, updated_at)
      SELECT COALESCE(NULLIF(c.client_id, ''), c.client_code),
             COALESCE(NULLIF(c.client_name, ''), COALESCE(NULLIF(c.client_id, ''), c.client_code)),
             COALESCE(NULLIF(c.sftp_path, ''), c.file_path),
             'ACTIVE',
             1,
             COALESCE(c.created_at, CURRENT_TIMESTAMP),
             COALESCE(c.updated_at, CURRENT_TIMESTAMP)
      FROM clients c
      WHERE c.id = NEW.client_ref_id
      ON CONFLICT(company_code) DO UPDATE SET
        company_name = excluded.company_name,
        sftp_path = COALESCE(excluded.sftp_path, company_master.sftp_path),
        updated_at = CURRENT_TIMESTAMP,
        is_active = 1;

      INSERT INTO entity_master (company_id, entity_code, entity_name, sftp_path, is_active, created_at, updated_at)
      SELECT cm.id,
             COALESCE(NEW.entity_code, ''),
             COALESCE(NULLIF(NEW.entity_code, ''), 'DEFAULT'),
             COALESCE(NULLIF(NEW.sftp_path, ''), NEW.file_path),
             1,
             COALESCE(NEW.created_at, CURRENT_TIMESTAMP),
             COALESCE(NEW.updated_at, CURRENT_TIMESTAMP)
      FROM company_master cm
      JOIN clients c ON c.id = NEW.client_ref_id
      WHERE cm.company_code = COALESCE(NULLIF(c.client_id, ''), c.client_code)
      ON CONFLICT(company_id, entity_code) DO UPDATE SET
        sftp_path = COALESCE(excluded.sftp_path, entity_master.sftp_path),
        updated_at = CURRENT_TIMESTAMP,
        is_active = 1;

      INSERT INTO automation_runs (
        external_run_id, company_id, entity_id, period, sftp_path, hris_filepath, paysheet_filepath,
        hris_status, paysheet_status, overall_status, created_at, updated_at,
        company_code, company_name, entity_code, run_status, common, file_path, source_entity_row_id
      )
      SELECT NULL,
             cm.id,
             em.id,
             COALESCE(NULLIF(NEW.period, ''), NEW.month, 'UNKNOWN'),
             COALESCE(NULLIF(NEW.sftp_path, ''), NEW.file_path),
             NEW.hrisFilePath,
             NEW.paysheetFilePath,
             COALESCE(NULLIF(NEW.status, ''), 'Pending'),
             COALESCE(NULLIF(NEW.uploadStatus, ''), 'Pending'),
             CASE
               WHEN UPPER(COALESCE(NEW.uploadStatus, '')) = 'UPLOADED' THEN 'Uploaded'
               ELSE COALESCE(NULLIF(NEW.status, ''), 'Pending')
             END,
             COALESCE(NEW.created_at, CURRENT_TIMESTAMP),
             COALESCE(NEW.updated_at, CURRENT_TIMESTAMP),
             cm.company_code,
             cm.company_name,
             NEW.entity_code,
             COALESCE(NULLIF(NEW.status, ''), 'Pending'),
             COALESCE(NULLIF(NEW.common, ''), cm.company_code || ':' || COALESCE(NEW.entity_code, '')),
             COALESCE(NULLIF(NEW.sftp_path, ''), NEW.file_path),
             NEW.id
      FROM company_master cm
      JOIN clients c ON c.id = NEW.client_ref_id
      LEFT JOIN entity_master em ON em.company_id = cm.id AND em.entity_code = COALESCE(NEW.entity_code, '')
      WHERE cm.company_code = COALESCE(NULLIF(c.client_id, ''), c.client_code)
      ON CONFLICT(company_id, entity_id, period) DO UPDATE SET
        sftp_path = excluded.sftp_path,
        hris_filepath = excluded.hris_filepath,
        paysheet_filepath = excluded.paysheet_filepath,
        hris_status = excluded.hris_status,
        paysheet_status = excluded.paysheet_status,
        overall_status = excluded.overall_status,
        updated_at = CURRENT_TIMESTAMP,
        company_name = excluded.company_name,
        entity_code = excluded.entity_code,
        run_status = excluded.run_status,
        common = excluded.common,
        file_path = excluded.file_path,
        source_entity_row_id = excluded.source_entity_row_id;
    END;

    CREATE TRIGGER trg_entities_au_entity_master
    AFTER UPDATE ON entities
    BEGIN
      INSERT INTO entity_master (company_id, entity_code, entity_name, sftp_path, is_active, created_at, updated_at)
      SELECT cm.id,
             COALESCE(NEW.entity_code, ''),
             COALESCE(NULLIF(NEW.entity_code, ''), 'DEFAULT'),
             COALESCE(NULLIF(NEW.sftp_path, ''), NEW.file_path),
             1,
             COALESCE(NEW.created_at, CURRENT_TIMESTAMP),
             CURRENT_TIMESTAMP
      FROM company_master cm
      JOIN clients c ON c.id = NEW.client_ref_id
      WHERE cm.company_code = COALESCE(NULLIF(c.client_id, ''), c.client_code)
      ON CONFLICT(company_id, entity_code) DO UPDATE SET
        sftp_path = COALESCE(excluded.sftp_path, entity_master.sftp_path),
        updated_at = CURRENT_TIMESTAMP,
        is_active = 1;

      INSERT INTO sftp_path_history (company_id, entity_id, level_type, old_path, new_path, remarks)
      SELECT cm.id,
             em.id,
             'ENTITY',
             COALESCE(NULLIF(OLD.sftp_path, ''), OLD.file_path),
             COALESCE(NULLIF(NEW.sftp_path, ''), NEW.file_path),
             'Synced from entities table'
      FROM company_master cm
      JOIN clients c ON c.id = NEW.client_ref_id
      LEFT JOIN entity_master em ON em.company_id = cm.id AND em.entity_code = COALESCE(NEW.entity_code, '')
      WHERE cm.company_code = COALESCE(NULLIF(c.client_id, ''), c.client_code)
        AND COALESCE(NULLIF(OLD.sftp_path, ''), OLD.file_path, '') <> COALESCE(NULLIF(NEW.sftp_path, ''), NEW.file_path, '')
        AND COALESCE(NULLIF(NEW.sftp_path, ''), NEW.file_path, '') <> '';

      UPDATE automation_runs
      SET sftp_path = COALESCE(NULLIF(NEW.sftp_path, ''), NEW.file_path),
          hris_filepath = NEW.hrisFilePath,
          paysheet_filepath = NEW.paysheetFilePath,
          hris_status = COALESCE(NULLIF(NEW.status, ''), 'Pending'),
          paysheet_status = COALESCE(NULLIF(NEW.uploadStatus, ''), 'Pending'),
          overall_status = CASE
            WHEN UPPER(COALESCE(NEW.uploadStatus, '')) = 'UPLOADED' THEN 'Uploaded'
            ELSE COALESCE(NULLIF(NEW.status, ''), 'Pending')
          END,
          updated_at = CURRENT_TIMESTAMP,
          entity_code = NEW.entity_code,
          run_status = COALESCE(NULLIF(NEW.status, ''), 'Pending'),
          common = COALESCE(NULLIF(NEW.common, ''), common),
          file_path = COALESCE(NULLIF(NEW.sftp_path, ''), NEW.file_path),
          source_entity_row_id = NEW.id,
          error_message = CASE WHEN UPPER(COALESCE(NEW.status, '')) = 'FAILED' OR UPPER(COALESCE(NEW.uploadStatus, '')) = 'FAILED' THEN COALESCE(error_message, 'Compatibility table status marked failed') ELSE error_message END
      WHERE source_entity_row_id = NEW.id
         OR (period = COALESCE(NULLIF(NEW.period, ''), NEW.month, 'UNKNOWN')
             AND entity_code = COALESCE(NEW.entity_code, '')
             AND company_id = (
               SELECT cm.id
               FROM company_master cm
               JOIN clients c ON c.id = NEW.client_ref_id
               WHERE cm.company_code = COALESCE(NULLIF(c.client_id, ''), c.client_code)
               LIMIT 1
             ));
    END;

    CREATE TRIGGER trg_entities_ad_entity_master
    AFTER DELETE ON entities
    BEGIN
      UPDATE entity_master
      SET is_active = 0,
          updated_at = CURRENT_TIMESTAMP
      WHERE entity_code = COALESCE(OLD.entity_code, '')
        AND company_id = (
          SELECT cm.id
          FROM company_master cm
          JOIN clients c ON c.id = OLD.client_ref_id
          WHERE cm.company_code = COALESCE(NULLIF(c.client_id, ''), c.client_code)
          LIMIT 1
        );
    END;

    CREATE TRIGGER trg_current_process_ai_runs
    AFTER INSERT ON current_process
    BEGIN
      INSERT INTO automation_runs (
        external_run_id, company_id, entity_id, period, sftp_path, hris_filepath, paysheet_filepath,
        hris_status, paysheet_status, overall_status, started_at, completed_at, updated_at,
        company_code, company_name, entity_code, run_status, common, file_path, source_entity_row_id
      )
      SELECT NEW.run_id,
             cm.id,
             em.id,
             COALESCE(NULLIF(NEW.period, ''), NEW.month, 'UNKNOWN'),
             NEW.file_path,
             NEW.hrisFilePath,
             NEW.paysheetFilePath,
             COALESCE(NULLIF(NEW.status, ''), 'Pending'),
             COALESCE(NULLIF(NEW.uploadStatus, ''), 'Pending'),
             COALESCE(NULLIF(NEW.run_status, ''), 'Running'),
             NEW.started_at,
             NEW.completed_at,
             CURRENT_TIMESTAMP,
             cm.company_code,
             COALESCE(NULLIF(NEW.client_name, ''), cm.company_name),
             NEW.entity_code,
             COALESCE(NULLIF(NEW.run_status, ''), 'Running'),
             COALESCE(NULLIF(NEW.common, ''), cm.company_code || ':' || COALESCE(NEW.entity_code, '')),
             NEW.file_path,
             NEW.source_client_id
      FROM entities e
      JOIN clients c ON c.id = e.client_ref_id
      JOIN company_master cm ON cm.company_code = COALESCE(NULLIF(c.client_id, ''), c.client_code)
      LEFT JOIN entity_master em ON em.company_id = cm.id AND em.entity_code = COALESCE(e.entity_code, '')
      WHERE e.id = NEW.source_client_id
      ON CONFLICT(company_id, entity_id, period) DO UPDATE SET
        external_run_id = excluded.external_run_id,
        sftp_path = excluded.sftp_path,
        hris_filepath = excluded.hris_filepath,
        paysheet_filepath = excluded.paysheet_filepath,
        hris_status = excluded.hris_status,
        paysheet_status = excluded.paysheet_status,
        overall_status = excluded.overall_status,
        started_at = COALESCE(excluded.started_at, automation_runs.started_at),
        completed_at = excluded.completed_at,
        updated_at = CURRENT_TIMESTAMP,
        company_name = excluded.company_name,
        entity_code = excluded.entity_code,
        run_status = excluded.run_status,
        common = excluded.common,
        file_path = excluded.file_path,
        source_entity_row_id = excluded.source_entity_row_id;
    END;

    CREATE TRIGGER trg_current_process_au_runs
    AFTER UPDATE ON current_process
    BEGIN
      UPDATE automation_runs
      SET external_run_id = NEW.run_id,
          sftp_path = NEW.file_path,
          hris_filepath = NEW.hrisFilePath,
          paysheet_filepath = NEW.paysheetFilePath,
          hris_status = COALESCE(NULLIF(NEW.status, ''), hris_status),
          paysheet_status = COALESCE(NULLIF(NEW.uploadStatus, ''), paysheet_status),
          overall_status = COALESCE(NULLIF(NEW.run_status, ''), overall_status),
          started_at = COALESCE(NEW.started_at, started_at),
          completed_at = NEW.completed_at,
          updated_at = CURRENT_TIMESTAMP,
          company_name = COALESCE(NULLIF(NEW.client_name, ''), company_name),
          entity_code = COALESCE(NULLIF(NEW.entity_code, ''), entity_code),
          run_status = COALESCE(NULLIF(NEW.run_status, ''), run_status),
          common = COALESCE(NULLIF(NEW.common, ''), common),
          file_path = COALESCE(NULLIF(NEW.file_path, ''), file_path)
      WHERE source_entity_row_id = NEW.source_client_id
         OR external_run_id = NEW.run_id;
    END;

    CREATE TRIGGER trg_history_ai_snapshot
    AFTER INSERT ON automation_history
    BEGIN
      UPDATE automation_history
      SET period = COALESCE(NULLIF(NEW.period, ''), NEW.month),
          sftp_path = COALESCE(NULLIF(NEW.sftp_path, ''), NEW.file_path),
          hris_filepath = COALESCE(NULLIF(NEW.hris_filepath, ''), NEW.hrisFilePath),
          paysheet_filepath = COALESCE(NULLIF(NEW.paysheet_filepath, ''), NEW.paysheetFilePath),
          hris_status = COALESCE(NULLIF(NEW.hris_status, ''), NEW.status),
          paysheet_status = COALESCE(NULLIF(NEW.paysheet_status, ''), NEW.uploadStatus),
          overall_status = COALESCE(NULLIF(NEW.overall_status, ''), NEW.run_status, NEW.status),
          company_id = COALESCE(NEW.company_id, (
            SELECT cm.id
            FROM entities e
            JOIN clients c ON c.id = e.client_ref_id
            JOIN company_master cm ON cm.company_code = COALESCE(NULLIF(c.client_id, ''), c.client_code)
            WHERE e.id = NEW.source_client_id
            LIMIT 1
          )),
          entity_id = COALESCE(NEW.entity_id, (
            SELECT em.id
            FROM entities e
            JOIN clients c ON c.id = e.client_ref_id
            JOIN company_master cm ON cm.company_code = COALESCE(NULLIF(c.client_id, ''), c.client_code)
            LEFT JOIN entity_master em ON em.company_id = cm.id AND em.entity_code = COALESCE(e.entity_code, '')
            WHERE e.id = NEW.source_client_id
            LIMIT 1
          )),
          company_code = COALESCE(NULLIF(NEW.company_code, ''), (
            SELECT COALESCE(NULLIF(c.client_id, ''), c.client_code)
            FROM entities e JOIN clients c ON c.id = e.client_ref_id
            WHERE e.id = NEW.source_client_id LIMIT 1
          )),
          company_name = COALESCE(NULLIF(NEW.company_name, ''), (
            SELECT c.client_name FROM entities e JOIN clients c ON c.id = e.client_ref_id
            WHERE e.id = NEW.source_client_id LIMIT 1
          )),
          entity_code = COALESCE(NULLIF(NEW.entity_code, ''), (
            SELECT e.entity_code FROM entities e WHERE e.id = NEW.source_client_id LIMIT 1
          ))
      WHERE id = NEW.id;
    END;

    CREATE TRIGGER trg_history_au_snapshot
    AFTER UPDATE ON automation_history
    BEGIN
      UPDATE automation_history
      SET archived_at = COALESCE(archived_at, CURRENT_TIMESTAMP)
      WHERE id = NEW.id;
    END;

    CREATE TRIGGER trg_logs_ai_sync
    AFTER INSERT ON automation_logs
    BEGIN
      UPDATE automation_logs
      SET log_level = COALESCE(NULLIF(NEW.log_level, ''), NEW.level, 'info'),
          step_name = COALESCE(NULLIF(NEW.step_name, ''), NEW.event_type, 'LOG')
      WHERE id = NEW.id;
    END;

    CREATE TRIGGER trg_logs_au_sync
    AFTER UPDATE ON automation_logs
    BEGIN
      UPDATE automation_logs
      SET log_level = COALESCE(NULLIF(NEW.log_level, ''), NEW.level, 'info'),
          step_name = COALESCE(NULLIF(NEW.step_name, ''), NEW.event_type, 'LOG')
      WHERE id = NEW.id;
    END;

    CREATE TRIGGER trg_audit_ai_sync
    AFTER INSERT ON audit_logs
    BEGIN
      UPDATE audit_logs
      SET module_name = COALESCE(NULLIF(NEW.module_name, ''), NULLIF(NEW.page, ''), NULLIF(NEW.section, ''), 'UI'),
          target_table = COALESCE(NULLIF(NEW.target_table, ''), NULLIF(NEW.target, ''), 'UI'),
          performed_at = COALESCE(NEW.performed_at, NEW.created_at, CURRENT_TIMESTAMP)
      WHERE id = NEW.id;
    END;

    CREATE TRIGGER trg_audit_au_sync
    AFTER UPDATE ON audit_logs
    BEGIN
      UPDATE audit_logs
      SET module_name = COALESCE(NULLIF(NEW.module_name, ''), NULLIF(NEW.page, ''), NULLIF(NEW.section, ''), 'UI'),
          target_table = COALESCE(NULLIF(NEW.target_table, ''), NULLIF(NEW.target, ''), 'UI'),
          performed_at = COALESCE(NEW.performed_at, NEW.created_at, CURRENT_TIMESTAMP)
      WHERE id = NEW.id;
    END;

    CREATE TRIGGER trg_settings_ai_sync
    AFTER INSERT ON app_settings
    BEGIN
      UPDATE app_settings
      SET common = COALESCE(NULLIF(NEW.common, ''), NEW.setting_key),
          updated_at = COALESCE(NEW.updated_at, CURRENT_TIMESTAMP)
      WHERE id = NEW.id;
    END;

    CREATE TRIGGER trg_settings_au_sync
    AFTER UPDATE ON app_settings
    BEGIN
      UPDATE app_settings
      SET common = COALESCE(NULLIF(NEW.common, ''), NEW.setting_key),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = NEW.id;
    END;
  `);
}

function backfillRequestedTables() {
  db.run(`
    INSERT INTO company_master (company_code, company_name, sftp_path, status, is_active, created_at, updated_at)
    SELECT DISTINCT
      COALESCE(NULLIF(client_id, ''), client_code),
      COALESCE(NULLIF(client_name, ''), COALESCE(NULLIF(client_id, ''), client_code)),
      COALESCE(NULLIF(sftp_path, ''), file_path),
      CASE WHEN UPPER(COALESCE(status, '')) IN ('ACTIVE', 'STOPPED', 'RELEASED', 'INACTIVE') THEN UPPER(status) ELSE 'ACTIVE' END,
      1,
      COALESCE(created_at, CURRENT_TIMESTAMP),
      COALESCE(updated_at, CURRENT_TIMESTAMP)
    FROM clients
    WHERE COALESCE(NULLIF(client_id, ''), client_code) IS NOT NULL
    ON CONFLICT(company_code) DO UPDATE SET
      company_name = excluded.company_name,
      sftp_path = COALESCE(excluded.sftp_path, company_master.sftp_path),
      updated_at = CURRENT_TIMESTAMP,
      is_active = 1
  `);

  db.run(`
    INSERT INTO entity_master (company_id, entity_code, entity_name, sftp_path, is_active, created_at, updated_at)
    SELECT DISTINCT
      cm.id,
      COALESCE(e.entity_code, ''),
      COALESCE(NULLIF(e.entity_code, ''), 'DEFAULT'),
      COALESCE(NULLIF(e.sftp_path, ''), e.file_path),
      1,
      COALESCE(e.created_at, CURRENT_TIMESTAMP),
      COALESCE(e.updated_at, CURRENT_TIMESTAMP)
    FROM entities e
    JOIN clients c ON c.id = e.client_ref_id
    JOIN company_master cm ON cm.company_code = COALESCE(NULLIF(c.client_id, ''), c.client_code)
    ON CONFLICT(company_id, entity_code) DO UPDATE SET
      sftp_path = COALESCE(excluded.sftp_path, entity_master.sftp_path),
      updated_at = CURRENT_TIMESTAMP,
      is_active = 1
  `);

  db.run(`
    INSERT INTO automation_runs (
      external_run_id, company_id, entity_id, period, sftp_path, hris_filepath, paysheet_filepath,
      hris_status, paysheet_status, overall_status, started_at, completed_at, created_at, updated_at,
      company_code, company_name, entity_code, run_status, common, file_path, source_entity_row_id
    )
    SELECT
      NULL,
      cm.id,
      em.id,
      COALESCE(NULLIF(e.period, ''), e.month, 'UNKNOWN'),
      COALESCE(NULLIF(e.sftp_path, ''), e.file_path),
      e.hrisFilePath,
      e.paysheetFilePath,
      COALESCE(NULLIF(e.status, ''), 'Pending'),
      COALESCE(NULLIF(e.uploadStatus, ''), 'Pending'),
      CASE WHEN UPPER(COALESCE(e.uploadStatus, '')) = 'UPLOADED' THEN 'Uploaded' ELSE COALESCE(NULLIF(e.status, ''), 'Pending') END,
      NULL,
      NULL,
      COALESCE(e.created_at, CURRENT_TIMESTAMP),
      COALESCE(e.updated_at, CURRENT_TIMESTAMP),
      cm.company_code,
      cm.company_name,
      e.entity_code,
      COALESCE(NULLIF(e.status, ''), 'Pending'),
      COALESCE(NULLIF(e.common, ''), cm.company_code || ':' || COALESCE(e.entity_code, '')),
      COALESCE(NULLIF(e.sftp_path, ''), e.file_path),
      e.id
    FROM entities e
    JOIN clients c ON c.id = e.client_ref_id
    JOIN company_master cm ON cm.company_code = COALESCE(NULLIF(c.client_id, ''), c.client_code)
    LEFT JOIN entity_master em ON em.company_id = cm.id AND em.entity_code = COALESCE(e.entity_code, '')
    ON CONFLICT(company_id, entity_id, period) DO UPDATE SET
      sftp_path = excluded.sftp_path,
      hris_filepath = excluded.hris_filepath,
      paysheet_filepath = excluded.paysheet_filepath,
      hris_status = excluded.hris_status,
      paysheet_status = excluded.paysheet_status,
      overall_status = excluded.overall_status,
      updated_at = CURRENT_TIMESTAMP,
      company_name = excluded.company_name,
      entity_code = excluded.entity_code,
      run_status = excluded.run_status,
      common = excluded.common,
      file_path = excluded.file_path,
      source_entity_row_id = excluded.source_entity_row_id
  `);
}

db.serialize(() => {
  createCompatibilityTables();
  createRequestedTables();
  createSyncTriggers();
  backfillRequestedTables();
});

module.exports = db;
