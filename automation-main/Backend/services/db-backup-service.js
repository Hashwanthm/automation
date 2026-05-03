// Database backup and restore helpers.
// Keeps one live SQLite database while creating timestamped VACUUM INTO copies
// after successful automation runs.
const fs = require("fs");
const path = require("path");

const db = require("../config/database");

const backupDir = path.join(db.dataDir || path.join(__dirname, "..", "..", "data"), "backups");

function ensureBackupDir() {
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
}

function runDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function allDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function sanitizeName(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "run";
}

function createBackupName(runId = "manual") {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17);
  return `main-${timestamp}-${sanitizeName(runId)}.db`;
}

async function createDatabaseBackup(runId = "manual") {
  ensureBackupDir();
  const fileName = createBackupName(runId);
  const filePath = path.join(backupDir, fileName);

  await runDb(`VACUUM INTO ${quoteLiteral(filePath)}`);

  const stats = await fs.promises.stat(filePath);
  return {
    name: fileName,
    path: filePath,
    size: stats.size,
    createdAt: stats.birthtime || stats.mtime
  };
}

async function listDatabaseBackups() {
  ensureBackupDir();
  const files = await fs.promises.readdir(backupDir, { withFileTypes: true });
  const backups = await Promise.all(
    files
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".db"))
      .map(async (entry) => {
        const filePath = path.join(backupDir, entry.name);
        const stats = await fs.promises.stat(filePath);
        return {
          name: entry.name,
          size: stats.size,
          createdAt: stats.birthtime || stats.mtime
        };
      })
  );

  return backups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function resolveBackupPath(fileName) {
  ensureBackupDir();
  const safeName = path.basename(String(fileName || ""));
  if (!safeName || !safeName.toLowerCase().endsWith(".db")) {
    throw new Error("Select a valid backup file.");
  }

  const filePath = path.resolve(backupDir, safeName);
  const root = path.resolve(backupDir);
  if (!filePath.startsWith(root + path.sep)) {
    throw new Error("Invalid backup path.");
  }
  if (!fs.existsSync(filePath)) {
    throw new Error("Backup file was not found.");
  }

  return filePath;
}

async function getRestoreTables() {
  const rows = await allDb(`
    SELECT name
    FROM restore.sqlite_master
    WHERE type='table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `);
  return rows.map((row) => row.name);
}

async function getColumns(schemaName, tableName) {
  const schema = schemaName === "restore" ? "restore" : "main";
  const rows = await allDb(`PRAGMA ${schema}.table_info(${quoteLiteral(tableName)})`);
  return rows.map((row) => row.name);
}

async function restoreDatabaseBackup(fileName) {
  const filePath = resolveBackupPath(fileName);
  await runDb("PRAGMA foreign_keys=OFF");
  await runDb(`ATTACH DATABASE ${quoteLiteral(filePath)} AS restore`);

  try {
    const tables = await getRestoreTables();
    await runDb("BEGIN IMMEDIATE TRANSACTION");

    for (const table of tables) {
      const mainColumns = await getColumns("main", table).catch(() => []);
      const restoreColumns = await getColumns("restore", table);
      const columns = restoreColumns.filter((column) => mainColumns.includes(column));
      if (!columns.length) continue;

      const tableName = quoteIdentifier(table);
      const columnList = columns.map(quoteIdentifier).join(", ");
      await runDb(`DELETE FROM main.${tableName}`);
      await runDb(`INSERT INTO main.${tableName} (${columnList}) SELECT ${columnList} FROM restore.${tableName}`);
    }

    await runDb("COMMIT");
    await runDb("PRAGMA foreign_keys=ON");
    await runDb("VACUUM");

    return { name: path.basename(filePath), restoredTables: tables.length };
  } catch (err) {
    await runDb("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await runDb("DETACH DATABASE restore").catch(() => {});
    await runDb("PRAGMA foreign_keys=ON").catch(() => {});
  }
}

module.exports = {
  backupDir,
  createDatabaseBackup,
  listDatabaseBackups,
  restoreDatabaseBackup
};
