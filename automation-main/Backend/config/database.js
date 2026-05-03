// SQLite connection and schema bootstrap.
// Owns the local automation database shape and performs safe additive migrations
// so older local databases continue working after code updates.
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3-offline-next");

const dataDir = path.join(__dirname, "..", "..", "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const legacyDbPath = path.join(dataDir, "automation.db");
const dbPath = path.join(dataDir, "main.db");

if (!fs.existsSync(dbPath) && fs.existsSync(legacyDbPath)) {
  fs.renameSync(legacyDbPath, dbPath);
}

const db = new sqlite3.Database(dbPath);
db.dbPath = dbPath;
db.dataDir = dataDir;

// Keep this list aligned with CREATE TABLE. New fields can be added here without
// asking users to delete their existing automation.db file.
const expectedColumns = {
  client_id: "TEXT",
  client_name: "TEXT",
  client_code: "TEXT",
  entity_code: "TEXT",
  sftp_path: "TEXT",
  month: "TEXT",
  period: "TEXT",
  common: "TEXT",
  file_path: "TEXT",
  hrisFilePath: "TEXT",
  paysheetFilePath: "TEXT",
  status: "TEXT DEFAULT 'Pending'",
  uploadStatus: "TEXT DEFAULT 'Pending'",
  modified_by: "TEXT DEFAULT 'System'",
  updated_at: "DATETIME",
  created_at: "DATETIME DEFAULT CURRENT_TIMESTAMP"
};

const entityExpectedColumns = {
  client_ref_id: "INTEGER",
  client_id: "TEXT",
  client_code: "TEXT",
  entity_code: "TEXT",
  sftp_path: "TEXT",
  month: "TEXT",
  period: "TEXT",
  common: "TEXT",
  file_path: "TEXT",
  hrisFilePath: "TEXT",
  paysheetFilePath: "TEXT",
  status: "TEXT DEFAULT 'Pending'",
  uploadStatus: "TEXT DEFAULT 'Pending'",
  modified_by: "TEXT DEFAULT 'System'",
  updated_at: "DATETIME",
  created_at: "DATETIME DEFAULT CURRENT_TIMESTAMP"
};

const processTableColumns = `
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
`;

const processExpectedColumns = {
  run_id: "TEXT",
  source_client_id: "INTEGER",
  client_name: "TEXT",
  client_code: "TEXT",
  entity_code: "TEXT",
  month: "TEXT",
  period: "TEXT",
  common: "TEXT",
  file_path: "TEXT",
  hrisFilePath: "TEXT",
  paysheetFilePath: "TEXT",
  status: "TEXT DEFAULT 'Pending'",
  uploadStatus: "TEXT DEFAULT 'Pending'",
  run_status: "TEXT",
  created_at: "DATETIME",
  started_at: "DATETIME",
  completed_at: "DATETIME"
};

const logExpectedColumns = {
  run_id: "TEXT",
  level: "TEXT DEFAULT 'info'",
  event_type: "TEXT",
  client_id: "TEXT",
  client_name: "TEXT",
  entity_code: "TEXT",
  month: "TEXT",
  period: "TEXT",
  common: "TEXT",
  message: "TEXT",
  details: "TEXT",
  created_at: "DATETIME DEFAULT CURRENT_TIMESTAMP"
};

const auditExpectedColumns = {
  action: "TEXT",
  target: "TEXT",
  label: "TEXT",
  value: "TEXT",
  page: "TEXT",
  section: "TEXT",
  path: "TEXT",
  period: "TEXT",
  common: "TEXT",
  details: "TEXT",
  created_at: "DATETIME DEFAULT CURRENT_TIMESTAMP"
};

const appSettingsExpectedColumns = {
  setting_value: "TEXT",
  period: "TEXT",
  common: "TEXT",
  updated_at: "DATETIME DEFAULT CURRENT_TIMESTAMP"
};

function addMissingColumns(tableName, expected, after = () => {}) {
  db.all(`PRAGMA table_info(${tableName})`, (err, columns) => {
    if (err) {
      console.error(`Could not inspect ${tableName} table:`, err.message);
      after(err);
      return;
    }

    const existing = new Set(columns.map((column) => column.name));
    const missingColumns = Object.entries(expected).filter(([name]) => !existing.has(name));

    if (!missingColumns.length) {
      after();
      return;
    }

    let pending = missingColumns.length;
    missingColumns.forEach(([name, definition]) => {
      db.run(`ALTER TABLE ${tableName} ADD COLUMN ${name} ${definition}`, (alterErr) => {
        if (alterErr) console.error(`Could not add ${name} column to ${tableName}:`, alterErr.message);
        pending -= 1;
        if (!pending) after();
      });
    });
  });
}

function backfillClientAliases() {
  db.run(`
    UPDATE clients
    SET client_id = COALESCE(NULLIF(client_id, ''), client_code),
        sftp_path = COALESCE(NULLIF(sftp_path, ''), file_path),
        period = COALESCE(NULLIF(period, ''), month),
        common = COALESCE(NULLIF(common, ''), COALESCE(NULLIF(client_id, ''), client_code)),
        modified_by = COALESCE(NULLIF(modified_by, ''), 'System'),
        updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)
  `, (err) => {
    if (err) {
      console.error("Could not backfill client alias columns:", err.message);
    }
  });
}

function backfillEntities() {
  db.run(`
    INSERT INTO entities
      (client_ref_id, client_id, client_code, entity_code, sftp_path, month, file_path,
       hrisFilePath, paysheetFilePath, status, uploadStatus, updated_at, created_at)
    SELECT
      c.id,
      COALESCE(NULLIF(c.client_id, ''), c.client_code),
      COALESCE(NULLIF(c.client_id, ''), c.client_code),
      c.entity_code,
      COALESCE(NULLIF(c.sftp_path, ''), c.file_path),
      c.month,
      COALESCE(NULLIF(c.sftp_path, ''), c.file_path),
      c.hrisFilePath,
      c.paysheetFilePath,
      COALESCE(NULLIF(c.status, ''), 'Pending'),
      COALESCE(NULLIF(c.uploadStatus, ''), 'Pending'),
      COALESCE(c.updated_at, CURRENT_TIMESTAMP),
      COALESCE(c.created_at, CURRENT_TIMESTAMP)
    FROM clients c
    WHERE NULLIF(c.entity_code, '') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM entities e
        WHERE e.client_ref_id = c.id
          AND lower(COALESCE(e.entity_code, '')) = lower(COALESCE(c.entity_code, ''))
      )
  `, (err) => {
    if (err) {
      console.error("Could not backfill entities table:", err.message);
    }
  });
}

function backfillEntitiesMetadata() {
  db.run(`
    UPDATE entities
    SET period = COALESCE(NULLIF(period, ''), month),
        common = COALESCE(
          NULLIF(common, ''),
          COALESCE(NULLIF(client_id, ''), client_code, '') || CASE
            WHEN NULLIF(entity_code, '') IS NOT NULL THEN ':' || entity_code
            ELSE ''
          END
        ),
        modified_by = COALESCE(NULLIF(modified_by, ''), 'System'),
        updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)
  `, (err) => {
    if (err) {
      console.error("Could not backfill entity metadata columns:", err.message);
    }
  });
}

function backfillProcessMetadata(tableName) {
  db.run(`
    UPDATE ${tableName}
    SET period = COALESCE(NULLIF(period, ''), month),
        common = COALESCE(
          NULLIF(common, ''),
          COALESCE(NULLIF(client_code, ''), '') || CASE
            WHEN NULLIF(entity_code, '') IS NOT NULL THEN ':' || entity_code
            ELSE ''
          END
        )
  `, (err) => {
    if (err) {
      console.error(`Could not backfill ${tableName} metadata columns:`, err.message);
    }
  });
}

function backfillLogMetadata() {
  db.run(`
    UPDATE automation_logs
    SET period = COALESCE(NULLIF(period, ''), month),
        common = COALESCE(NULLIF(common, ''), COALESCE(NULLIF(client_id, ''), run_id, event_type, ''))
  `, (err) => {
    if (err) {
      console.error("Could not backfill automation log metadata columns:", err.message);
    }
  });
}

function backfillAuditMetadata() {
  db.run(`
    UPDATE audit_logs
    SET period = COALESCE(NULLIF(period, ''), ''),
        common = COALESCE(NULLIF(common, ''), COALESCE(NULLIF(page, ''), '') || CASE
          WHEN NULLIF(section, '') IS NOT NULL THEN ':' || section
          ELSE ''
        END)
  `, (err) => {
    if (err) {
      console.error("Could not backfill audit log metadata columns:", err.message);
    }
  });
}

function backfillSettingsMetadata() {
  db.run(`
    UPDATE app_settings
    SET period = COALESCE(NULLIF(period, ''), ''),
        common = COALESCE(NULLIF(common, ''), setting_key)
  `, (err) => {
    if (err) {
      console.error("Could not backfill settings metadata columns:", err.message);
    }
  });
}

function recreateCurrentProcessSyncTrigger() {
  db.serialize(() => {
    db.run("DROP TRIGGER IF EXISTS sync_current_process_after_client_update");
    db.run("DROP TRIGGER IF EXISTS sync_current_process_after_entity_update");
    db.run(`
      CREATE TRIGGER sync_current_process_after_client_update
      AFTER UPDATE ON clients
      BEGIN
        UPDATE current_process
        SET client_name = NEW.client_name,
            client_code = COALESCE(NEW.client_id, NEW.client_code)
        WHERE source_client_id IN (
          SELECT id FROM entities WHERE client_ref_id = NEW.id
        );
      END
    `);
    db.run(`
      CREATE TRIGGER sync_current_process_after_entity_update
      AFTER UPDATE ON entities
      BEGIN
        UPDATE current_process
        SET client_code = COALESCE(NEW.client_id, NEW.client_code),
            entity_code = NEW.entity_code,
            month = NEW.month,
            period = COALESCE(NEW.period, NEW.month),
            common = COALESCE(NEW.common, COALESCE(NEW.client_id, NEW.client_code, '') || ':' || COALESCE(NEW.entity_code, '')),
            file_path = COALESCE(NEW.sftp_path, NEW.file_path),
            hrisFilePath = NEW.hrisFilePath,
            paysheetFilePath = NEW.paysheetFilePath,
            status = NEW.status,
            uploadStatus = NEW.uploadStatus
        WHERE source_client_id = NEW.id;
      END
    `);
  });
}

db.serialize(() => {
  // Base schema for a fresh installation.
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
      modified_by TEXT DEFAULT 'System',
      updated_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  addMissingColumns("clients", expectedColumns, backfillClientAliases);

  // Entity master/current state. A client can own many entity rows, allowing the
  // same Client ID to be processed separately for different Entity Codes.
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

  addMissingColumns("entities", entityExpectedColumns, () => {
    backfillEntities();
    backfillEntitiesMetadata();
  });
  db.run("CREATE INDEX IF NOT EXISTS idx_entities_client_entity ON entities (client_id, entity_code)");

  // Active automation snapshot. It is rebuilt at the beginning of each run and
  // mirrors status updates while the run is in progress.
  db.run(`
    CREATE TABLE IF NOT EXISTS current_process (
      ${processTableColumns}
    )
  `);

  // Completed automation history. Rows are appended at the end of each run so
  // operators can audit what happened without losing the master client list.
  db.run(`
    CREATE TABLE IF NOT EXISTS automation_history (
      ${processTableColumns}
    )
  `);

  addMissingColumns("current_process", processExpectedColumns, () => backfillProcessMetadata("current_process"));
  addMissingColumns("automation_history", processExpectedColumns, () => backfillProcessMetadata("automation_history"));

  // Persistent audit log. The UI still receives live Server-Sent Events, while
  // this table preserves operational logs across browser refreshes and restarts.
  db.run(`
    CREATE TABLE IF NOT EXISTS automation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      level TEXT DEFAULT 'info',
      event_type TEXT,
      client_id TEXT,
      client_name TEXT,
      entity_code TEXT,
      month TEXT,
      period TEXT,
      common TEXT,
      message TEXT,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  addMissingColumns("automation_logs", logExpectedColumns, backfillLogMetadata);

  // UI audit trail. This captures operator clicks and option changes from the
  // React app without storing sensitive field values.
  db.run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT,
      target TEXT,
      label TEXT,
      value TEXT,
      page TEXT,
      section TEXT,
      path TEXT,
      period TEXT,
      common TEXT,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  addMissingColumns("audit_logs", auditExpectedColumns, backfillAuditMetadata);

  // Persist runtime settings, including portal credentials used by automation.
  db.run(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT,
      period TEXT,
      common TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  addMissingColumns("app_settings", appSettingsExpectedColumns, backfillSettingsMetadata);

  recreateCurrentProcessSyncTrigger();
});

module.exports = db;
