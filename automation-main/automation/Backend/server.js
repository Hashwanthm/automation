// Backend API entry point.
// Coordinates client ingestion, automation commands, live log streaming, and
// lightweight database access used by the React UI.
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const dns = require("dns").promises;

const db = require("./config/database");
const { loadRuntimeSettings, updateRuntimeSettings } = require("./config/runtime-settings");
const { runAutomation } = require("./automation/download-paysheet");
const { readExcel } = require("./services/excel-service");
const {
  cleanText,
  normalizeAndValidateClientRecord,
  normalizeAndValidateClientConfiguration,
  titleCaseWords
} = require("./services/client-normalizer");
const { createDatabaseBackup, listDatabaseBackups, restoreDatabaseBackup } = require("./services/db-backup-service");
const uploadPaysheetBulk = require("./automation/upload-paysheet");

const app = express();
const PORT = process.env.PORT || 3000;
const uploadDir = path.join(__dirname, "uploads");
const tempDir = path.join(__dirname, "temp");
const NETWORK_CHECK_HOST = process.env.NETWORK_CHECK_HOST || "www.google.com";
const SUPPORT_MESSAGE = "Reach to VISTA TEAM.";

class AppError extends Error {
  constructor(message, statusCode = 500, details = {}) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.details = details;
    this.supportMessage = details.supportMessage;
  }
}

function getErrorStatus(err) {
  if (err?.statusCode) return err.statusCode;
  if (err?.code === "ECONNREFUSED" || err?.code === "ETIMEDOUT") return 503;
  if (err?.code === "SQLITE_CONSTRAINT") return 409;
  return 500;
}

function publicErrorMessage(err, fallback = "Request failed.") {
  const message = String(err?.message || fallback).trim();
  if (!message) return fallback;
  return message.replace(/\s+/g, " ").slice(0, 500);
}

function sendErrorResponse(res, err, fallback = "Request failed.") {
  const statusCode = getErrorStatus(err);
  res.status(statusCode).json({
    success: false,
    error: publicErrorMessage(err, fallback),
    code: err?.code || err?.name || "ERROR",
    supportMessage: err?.supportMessage || (statusCode >= 500 ? SUPPORT_MESSAGE : undefined),
    details: err?.details || undefined
  });
}

function getValidatedClientRecord(body = {}, rowLabel = "Company") {
  try {
    return normalizeAndValidateClientRecord(body, rowLabel);
  } catch (err) {
    throw new AppError(err.message, 400);
  }
}

function getValidatedClientConfiguration(body = {}, rowLabel = "Company") {
  try {
    return normalizeAndValidateClientConfiguration(body, rowLabel);
  } catch (err) {
    throw new AppError(err.message, 400);
  }
}

function safeUnlink(filePath) {
  if (!filePath) return;
  fs.promises.unlink(filePath).catch(() => {});
}

async function cleanupTempFolder() {
  await fs.promises.rm(tempDir, { recursive: true, force: true });
  await fs.promises.mkdir(tempDir, { recursive: true });
}

// Ensure runtime upload storage exists before Multer writes incoming files.
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(path.join(__dirname, "../Frontend/dist")));
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) {
    sendErrorResponse(res, new AppError("Invalid JSON request body.", 400));
    return;
  }
  next(err);
});

let streamClients = [];
let automationRunning = false;
global.automationStopRequested = false;
global.automationPauseRequested = false;
global.currentRunId = null;

// Server-Sent Events broadcaster used by automation modules for live UI updates.
function send(message) {
  recordAutomationLog(message).catch((err) => {
    console.error("Could not persist automation log:", err.message);
  });

  const payload = `data: ${JSON.stringify(message)}\n\n`;
  streamClients = streamClients.filter((client) => {
    try {
      client.write(payload);
      return true;
    } catch (err) {
      console.error("Could not write SSE event:", err.message);
      return false;
    }
  });
}

global.send = send;

// Promise wrappers keep route handlers readable while using sqlite callback APIs.
function runDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function execDb(sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => {
      if (err) reject(err);
      else resolve({ success: true });
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

function getDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

async function enqueueAutomationRun(data) {
  const job = {
    id: data?.runId || `local-${Date.now()}`,
    data: {
      runId: data?.runId,
      runMonth: data?.runMonth,
      reason: data?.reason,
      queuedAt: data?.queuedAt
    }
  };

  send({
    type: "QUEUE_JOB_QUEUED",
    runId: job.data.runId,
    month: job.data.runMonth,
    jobId: job.id,
    reason: job.data.reason
  });

  setImmediate(async () => {
    send({
      type: "QUEUE_JOB_ACTIVE",
      jobId: job.id,
      runId: job.data.runId,
      month: job.data.runMonth,
      reason: job.data.reason
    });

    try {
      await processAutomationJob(job);
      send({
        type: "QUEUE_JOB_COMPLETED",
        jobId: job.id,
        runId: job.data.runId,
        month: job.data.runMonth
      });
    } catch (err) {
      automationRunning = false;
      global.automationPauseRequested = false;
      global.currentRunId = null;
      send({
        type: "QUEUE_JOB_FAILED",
        jobId: job.id,
        runId: job.data.runId,
        month: job.data.runMonth,
        error: err.message
      });
    }
  });

  return job;
}

async function getAutomationQueueStatus() {
  return {
    name: "local",
    waiting: 0,
    active: automationRunning ? 1 : 0,
    delayed: 0,
    completed: 0,
    failed: 0
  };
}

function startAutomationWorker() {
  // Local automation execution does not require an external queue worker.
}

async function closeAutomationQueue() {
  // No external queue to close.
}

async function checkNetworkReachability() {
  try {
    await Promise.race([
      dns.lookup(NETWORK_CHECK_HOST),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Network check timed out")), 3000))
    ]);
    return true;
  } catch {
    return false;
  }
}

async function getTableColumns(tableName) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName || "")) return [];
  const rows = await allDb(`PRAGMA table_info("${tableName}")`);
  return rows.map((row) => row.name);
}

async function getColumnsForQuery(query, rows) {
  if (rows.length) return Object.keys(rows[0]);

  const selectMatch = query.match(/^select\s+(.+?)\s+from\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/i);
  if (!selectMatch) return [];

  const selectedColumns = selectMatch[1].trim();
  const tableName = selectMatch[2];
  const allColumns = await getTableColumns(tableName);

  if (!selectedColumns || selectedColumns === "*" || selectedColumns.includes(".*")) {
    return allColumns;
  }

  const queryColumns = selectedColumns
    .split(",")
    .map((column) => column.trim())
    .map((column) => {
      const alias = column.match(/\s+as\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?$/i);
      if (alias) return alias[1];
      return column.replace(/["'`]/g, "").split(".").pop().trim();
    })
    .filter((column) => allColumns.includes(column));

  return queryColumns.length ? queryColumns : allColumns;
}

function normalizeRunMonth(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return "";

  const monthCodes = {
    JANUARY: "JAN",
    JAN: "JAN",
    FEBRUARY: "FEB",
    FEB: "FEB",
    MARCH: "MAR",
    MAR: "MAR",
    APRIL: "APR",
    APR: "APR",
    MAY: "MAY",
    JUNE: "JUN",
    JUN: "JUN",
    JULY: "JUL",
    JUL: "JUL",
    AUGUST: "AUG",
    AUG: "AUG",
    SEPTEMBER: "SEP",
    SEPT: "SEP",
    SEP: "SEP",
    OCTOBER: "OCT",
    OCT: "OCT",
    NOVEMBER: "NOV",
    NOV: "NOV",
    DECEMBER: "DEC",
    DEC: "DEC"
  };

  const compact = raw.replace(/[\s_-]+/g, "");
  const yyyymmm = compact.match(/^(\d{4})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)$/);
  if (yyyymmm) return `${yyyymmm[1]}${yyyymmm[2]}`;

  const monthFirst = compact.match(/^([A-Z]+)(\d{4})$/);
  if (monthFirst && monthCodes[monthFirst[1]]) return `${monthFirst[2]}${monthCodes[monthFirst[1]]}`;

  const date = new Date(raw);
  if (!Number.isNaN(date.getTime())) {
    const month = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][date.getMonth()];
    return `${date.getFullYear()}${month}`;
  }

  return raw;
}

function mapAutomationClient(row, runMonth) {
  return {
    clientName: row.client_name,
    clientCode: row.client_id || row.client_code,
    entityCode: row.entity_code,
    month: runMonth || row.month,
    filePath: row.sftp_path || row.file_path,
    hrisFilePath: row.hrisFilePath,
    paysheetFilePath: row.paysheetFilePath
  };
}

function normalizeStatus(value, fallback = "Pending") {
  const status = String(value || fallback).trim();
  return status || fallback;
}

const clientEntitySelect = `
  SELECT
    em.id,
    em.id AS entity_id,
    cm.id AS client_master_id,
    cm.company_code AS client_id,
    cm.company_name AS client_name,
    cm.company_code AS client_code,
    COALESCE(cm.status, 'ACTIVE') AS client_status,
    em.entity_code,
    COALESCE(ar.period, '') AS month,
    COALESCE(ar.period, '') AS period,
    (cm.company_code || ':' || COALESCE(em.entity_code, '001')) AS common,
    COALESCE(em.sftp_path, cm.sftp_path, '') AS sftp_path,
    COALESCE(em.sftp_path, cm.sftp_path, '') AS file_path,
    ar.hris_filepath AS hrisFilePath,
    ar.paysheet_filepath AS paysheetFilePath,
    CASE
      WHEN COALESCE(ar.hris_status, 'Pending') = 'Completed'
       AND COALESCE(ar.paysheet_status, 'Pending') = 'Completed' THEN 'Downloaded'
      WHEN COALESCE(ar.hris_status, 'Pending') = 'Failed'
        OR COALESCE(ar.paysheet_status, 'Pending') = 'Failed' THEN 'Failed'
      WHEN COALESCE(ar.hris_status, 'Pending') = 'Processing'
        OR COALESCE(ar.paysheet_status, 'Pending') = 'Processing' THEN 'Processing'
      ELSE COALESCE(ar.run_status, 'Pending')
    END AS status,
    COALESCE(ar.upload_status, 'Pending') AS uploadStatus,
    'SYSTEM' AS modified_by,
    COALESCE(ar.updated_at, em.updated_at, cm.updated_at, em.created_at, cm.created_at) AS updated_at,
    COALESCE(ar.created_at, em.created_at, cm.created_at) AS created_at,
    CASE WHEN sp.id IS NOT NULL THEN 1 ELSE 0 END AS stop_process_enabled,
    ar.external_run_id,
    ar.id AS automation_run_id
  FROM entity_master em
  JOIN company_master cm ON cm.id = em.company_id
  LEFT JOIN automation_runs ar
    ON ar.id = (
      SELECT ar2.id
      FROM automation_runs ar2
      WHERE ar2.company_id = cm.id
        AND COALESCE(ar2.entity_id, 0) = COALESCE(em.id, 0)
      ORDER BY COALESCE(ar2.updated_at, ar2.created_at) DESC, ar2.id DESC
      LIMIT 1
    )
  LEFT JOIN stop_process sp
    ON sp.company_id = cm.id
   AND lower(COALESCE(sp.entity_code, '')) = lower(COALESCE(em.entity_code, ''))
`;

async function listClientEntityRows(where = "", params = []) {
  return allDb(
    `${clientEntitySelect}
     ${where}
     ORDER BY COALESCE(cm.company_name, cm.company_code), em.entity_code, em.id`,
    params
  );
}

async function getClientEntityRow(entityId) {
  return getDb(`${clientEntitySelect} WHERE em.id=?`, [entityId]);
}

async function listStoppedProcessRows() {
  return allDb(
    `SELECT
       sp.id,
       sp.company_id,
       cm.company_code AS client_code,
       cm.company_name AS client_name,
       COALESCE(NULLIF(sp.entity_code, ''), '001') AS entity_code,
       sp.done_by,
       sp.created_at
     FROM stop_process sp
     JOIN company_master cm ON cm.id = sp.company_id
     ORDER BY sp.created_at DESC, sp.id DESC`
  );
}

async function getClientMaster(clientId) {
  return getDb(
    `SELECT *
     FROM company_master
     WHERE lower(COALESCE(company_code, ''))=lower(?)
       AND deleted_at IS NULL
     ORDER BY id
     LIMIT 1`,
    [clientId]
  );
}

async function ensureClientMaster(clientId, clientName = "") {
  const normalizedClientId = cleanText(clientId);
  if (!normalizedClientId) throw new Error("Company ID is required.");
  const normalizedClientName = titleCaseWords(clientName || normalizedClientId);

  const existing = await getClientMaster(normalizedClientId);
  if (existing) {
    if (normalizedClientName && normalizedClientName !== existing.company_name) {
      await runDb(
        `UPDATE company_master
         SET company_name=?, updated_at=CURRENT_TIMESTAMP, deleted_at=NULL, status=COALESCE(status, 'ACTIVE'), is_active=1
         WHERE id=?`,
        [normalizedClientName, existing.id]
      );
      return { ...existing, company_code: normalizedClientId, company_name: normalizedClientName };
    }
    return existing;
  }

  const result = await runDb(
    `INSERT INTO company_master
     (company_code, company_name, status, is_active, created_at, updated_at)
     VALUES (?, ?, 'ACTIVE', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [normalizedClientId, normalizedClientName]
  );

  return getDb("SELECT * FROM company_master WHERE id=?", [result.lastID]);
}

async function findEntityForClient(clientRefId, entityCode) {
  return getDb(
    `SELECT *
     FROM entity_master
     WHERE company_id=?
       AND lower(COALESCE(entity_code, ''))=lower(?)
     LIMIT 1`,
    [clientRefId, entityCode]
  );
}
async function listEntitiesForClient(clientRefId) {
  return allDb(
    `SELECT *
     FROM entity_master
     WHERE company_id=?
     ORDER BY CASE WHEN COALESCE(entity_code, '')='' THEN 0 ELSE 1 END, entity_code, id`,
    [clientRefId]
  );
}

async function replaceClientEntities(clientMaster, config, modifiedBy = 'UI') {
  await runDb("DELETE FROM entity_master WHERE company_id=?", [clientMaster.id]);

  const rowsToInsert = config.hasEntities
    ? config.entities.map((entity) => ({
      entityCode: entity.entityCode,
      filePath: entity.filePath
    }))
    : [{
      entityCode: '001',
      filePath: config.filePath
    }];

  for (const row of rowsToInsert) {
    await runDb(
      `INSERT INTO entity_master
       (company_id, entity_code, entity_name, sftp_path, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        clientMaster.id,
        row.entityCode,
        row.entityCode === '001' && !config.hasEntities ? 'Default Entity' : `Entity ${row.entityCode}`,
        row.filePath
      ]
    );
  }
}

async function getClientConfiguration(clientId) {
  const clientMaster = await getClientMaster(clientId);
  if (!clientMaster) return null;

  const entities = await listEntitiesForClient(clientMaster.id);
  const latestRun = await getDb(
    `SELECT period, run_status, upload_status
     FROM automation_runs
     WHERE company_id=?
     ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
     LIMIT 1`,
    [clientMaster.id]
  );

  const hasEntities = entities.length > 1 || entities.some((entity) => {
    const code = cleanText(entity.entity_code);
    return code && code !== '001';
  });
  const placeholder = entities[0] || {};

  return {
    id: clientMaster.id,
    client_group_key: cleanText(clientMaster.company_code),
    client_id: cleanText(clientMaster.company_code),
    client_code: cleanText(clientMaster.company_code),
    client_name: clientMaster.company_name || '',
    month: latestRun?.period || '',
    status: latestRun?.run_status || 'Pending',
    uploadStatus: latestRun?.upload_status || 'Pending',
    has_entities: hasEntities,
    entity_code: hasEntities ? '' : '001',
    sftp_path: hasEntities ? '' : (placeholder.sftp_path || clientMaster.sftp_path || ''),
    file_path: hasEntities ? '' : (placeholder.sftp_path || clientMaster.sftp_path || ''),
    entities: hasEntities
      ? entities.map((entity) => ({
        id: entity.id,
        entity_code: entity.entity_code || '',
        entityCode: entity.entity_code || '',
        sftp_path: entity.sftp_path || '',
        file_path: entity.sftp_path || '',
        filePath: entity.sftp_path || '',
        status: clientMaster.status || 'ACTIVE'
      }))
      : []
  };
}


async function findEntityByBusinessKey(clientId, entityCode, month = "") {
  const params = [clientId, clientId, entityCode];
  let monthFilter = "";
  if (month) {
    monthFilter = " AND COALESCE(ar.period, '') = ?";
    params.push(month);
  }

  return getDb(
    `${clientEntitySelect}
     WHERE (lower(COALESCE(cm.company_code, ''))=lower(?) OR lower(COALESCE(cm.company_code, ''))=lower(?))
       AND lower(COALESCE(em.entity_code, ''))=lower(?)
       ${monthFilter}
     ORDER BY em.id
     LIMIT 1`,
    params
  );
}

async function deleteClientMasterIfOrphan(clientRefId) {
  const countRow = await getDb("SELECT COUNT(*) AS total FROM entity_master WHERE company_id=?", [clientRefId]);
  if (!countRow?.total) {
    await runDb("DELETE FROM company_master WHERE id=?", [clientRefId]);
  }
}

function logLevelForEvent(type) {
  if (String(type || "").includes("ERROR") || String(type || "").includes("FAILED")) return "error";
  if (String(type || "").includes("STOP")) return "warn";
  return "info";
}

function logMessageForEvent(message) {
  const type = message?.type;
  if (type === "AUTOMATION_STARTED") return "Automation started";
  if (type === "AUTOMATION_RECOVERED") return `Recovered interrupted automation run ${message.runId || ""}`.trim();
  if (type === "AUTOMATION_COMPLETED") return "Automation completed";
  if (type === "AUTOMATION_STOPPED") return "Automation stopped";
  if (type === "QUEUE_JOB_QUEUED") return `Queued automation run ${message.runId || ""}`.trim();
  if (type === "QUEUE_JOB_ACTIVE") return `Automation job started ${message.jobId || ""}`.trim();
  if (type === "QUEUE_JOB_COMPLETED") return `Automation job completed ${message.jobId || ""}`.trim();
  if (type === "QUEUE_JOB_FAILED") return `Automation job failed ${message.jobId || ""}: ${message.error || "Unknown error"}`.trim();
  if (type === "STOP_REQUESTED") return "Stop requested; current company will finish first";
  if (type === "PAUSE_REQUESTED") return "Pause requested; current company will finish first";
  if (type === "RESUME_REQUESTED") return "Automation resumed";
  if (type === "UPLOAD_FILE_LOADED") return `Loaded ${message.total || 0} companies from uploaded file`;
  if (type === "BACKUP_CREATED") return `Database backup created: ${message.backup || "backup"}`;
  if (type === "BACKUP_FAILED") return `Database backup failed: ${message.error || "Unknown error"}`;
  if (type === "BACKUP_RESTORED") return `Database backup restored: ${message.backup || "backup"}`;
  if (type === "TEMP_CLEANED") return "Temporary download folders cleaned";
  if (type === "TEMP_CLEANUP_FAILED") return `Temporary folder cleanup failed: ${message.error || "Unknown error"}`;
  if (type === "AUTOMATION_ERROR") return `Automation error: ${message.error || "Unknown error"}`;
  if (type === "START") return `Started processing company ${message.client}`;
  if (type === "HRIS_SUCCESS") return `HRIS downloaded for company ${message.client}`;
  if (type === "PAYSHEET_SUCCESS") return `Paysheet downloaded for company ${message.client}`;
  if (type === "SUCCESS") return `Download completed for company ${message.client}`;
  if (type === "FAILED") return `Download failed for company ${message.client}: ${message.error || "Unknown error"}`;
  if (type === "UPLOAD_START") return `Upload started for company ${message.client}`;
  if (type === "UPLOADED") return `Uploaded to destination for company ${message.client}`;
  if (type === "UPLOAD_FAILED") return `Upload failed for company ${message.client}: ${message.error || "Unknown error"}`;
  if (message?.message) return message.message;
  return type ? `Event received: ${type}` : "Log event received";
}

async function recordAutomationLog(message = {}) {
  const eventType = message.type || "LOG";
  if (eventType === "CONNECTED") return;

  await runDb(
    `INSERT INTO automation_logs
     (run_id, level, event_type, client_id, client_name, entity_code, month, period, common, message, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      message.runId || global.currentRunId || null,
      message.level || logLevelForEvent(eventType),
      eventType,
      message.client || message.clientId || null,
      message.clientName || null,
      message.entity || message.entityCode || null,
      message.month || null,
      normalizeRunMonth(message.period || message.month || ""),
      message.common || message.client || message.clientId || message.runId || global.currentRunId || eventType,
      logMessageForEvent(message),
      JSON.stringify(message)
    ]
  );
}

async function recordAuditLog(entry = {}) {
  const trim = (value, max = 500) => String(value || "").trim().slice(0, max);
  await runDb(
    `INSERT INTO audit_logs
     (action, target, label, value, page, section, path, period, common, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      trim(entry.action, 80),
      trim(entry.target, 80),
      trim(entry.label, 240),
      trim(entry.value, 240),
      trim(entry.page, 80),
      trim(entry.section, 80),
      trim(entry.path, 240),
      trim(entry.period, 80),
      trim(entry.common || `${entry.page || ""}:${entry.section || ""}`, 160),
      JSON.stringify(entry.details || {})
    ]
  );
}

global.log = (message, details = {}) => {
  recordAutomationLog({
    type: details.type || "LOG",
    level: details.level || "info",
    message,
    ...details
  }).catch((err) => {
    console.error("Could not persist manual log:", err.message);
  });
};

function createRunId() {
  return `RUN-${new Date().toISOString().replace(/[-:.TZ]/g, "")}`;
}

async function startCurrentProcess(runId, runMonth) {
  await runDb(
    `INSERT INTO automation_runs
     (external_run_id, company_id, entity_id, period, sftp_path, hris_status, paysheet_status, upload_status, overall_status,
      started_at, updated_at, company_code, company_name, entity_code, run_status)
     SELECT ?, cm.id, em.id, ?, COALESCE(em.sftp_path, cm.sftp_path),
            CASE WHEN COALESCE(ar.hris_status, 'Pending') = 'Completed' THEN 'Completed' ELSE 'Pending' END,
            CASE WHEN COALESCE(ar.paysheet_status, 'Pending') = 'Completed' THEN 'Completed' ELSE 'Pending' END,
            CASE WHEN COALESCE(ar.upload_status, 'Pending') = 'Completed' THEN 'Completed' ELSE 'Pending' END,
            CASE WHEN COALESCE(ar.overall_status, 'Pending') = 'Completed' THEN 'Completed' ELSE 'Pending' END,
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, cm.company_code, cm.company_name, em.entity_code,
            CASE WHEN COALESCE(ar.overall_status, 'Pending') = 'Completed' THEN 'Completed' ELSE 'Running' END
     FROM company_master cm
     JOIN entity_master em ON em.company_id = cm.id
     LEFT JOIN stop_process sp
       ON sp.company_id = cm.id
      AND lower(COALESCE(sp.entity_code, '')) = lower(COALESCE(em.entity_code, ''))
     LEFT JOIN automation_runs ar
       ON ar.id = (
          SELECT ar2.id
          FROM automation_runs ar2
          WHERE ar2.company_id = cm.id
            AND COALESCE(ar2.entity_id, 0) = COALESCE(em.id, 0)
            AND ar2.period = ?
          ORDER BY COALESCE(ar2.updated_at, ar2.created_at) DESC, ar2.id DESC
          LIMIT 1
       )
     WHERE COALESCE(cm.status, 'ACTIVE')='ACTIVE'
       AND COALESCE(cm.is_active, 1)=1
       AND COALESCE(em.is_active, 1)=1
       AND sp.id IS NULL
     ON CONFLICT(company_id, entity_id, period)
     DO UPDATE SET
       external_run_id=excluded.external_run_id,
       sftp_path=COALESCE(excluded.sftp_path, automation_runs.sftp_path),
       company_code=excluded.company_code,
       company_name=excluded.company_name,
       entity_code=excluded.entity_code,
       run_status=CASE WHEN automation_runs.overall_status='Completed' AND automation_runs.upload_status='Completed' THEN 'Completed' ELSE 'Running' END,
       updated_at=CURRENT_TIMESTAMP`,
    [runId, runMonth, runMonth]
  );
}

async function archiveCurrentProcess(runId, finalStatus) {
  await runDb(
    `INSERT INTO automation_history
     (run_id, company_id, entity_id, company_code, company_name, entity_code, period, sftp_path,
      hris_filepath, paysheet_filepath, hris_status, paysheet_status, overall_status,
      started_at, completed_at, error_message, run_status, status, uploadStatus, month, common, file_path, hrisFilePath, paysheetFilePath)
     SELECT external_run_id, company_id, entity_id, company_code, company_name, entity_code, period, sftp_path,
            hris_filepath, paysheet_filepath, hris_status, paysheet_status,
            CASE WHEN ?='Completed' AND COALESCE(upload_status, 'Pending')='Completed' THEN 'Completed' ELSE COALESCE(overall_status, ?) END,
            started_at, CURRENT_TIMESTAMP, error_message, ?,
            CASE
              WHEN COALESCE(hris_status, 'Pending')='Completed' AND COALESCE(paysheet_status, 'Pending')='Completed' THEN 'Downloaded'
              WHEN COALESCE(hris_status, 'Pending')='Failed' OR COALESCE(paysheet_status, 'Pending')='Failed' THEN 'Failed'
              ELSE COALESCE(run_status, 'Pending')
            END,
            COALESCE(upload_status, 'Pending'), period,
            company_code || ':' || COALESCE(entity_code, '001'), sftp_path, hris_filepath, paysheet_filepath
     FROM automation_runs
     WHERE external_run_id=?`,
    [finalStatus, finalStatus, finalStatus, runId]
  );

  await runDb(
    `UPDATE automation_runs
     SET run_status=?,
         overall_status=CASE WHEN ?='Completed' AND COALESCE(upload_status, 'Pending')='Completed' THEN 'Completed' ELSE COALESCE(overall_status, ?) END,
         completed_at=CURRENT_TIMESTAMP,
         updated_at=CURRENT_TIMESTAMP
     WHERE external_run_id=?`,
    [finalStatus, finalStatus, finalStatus, runId]
  );
}

async function getInterruptedRun() {
  return getDb(
    `SELECT external_run_id AS run_id, period AS month, COUNT(*) AS total
     FROM automation_runs
     WHERE external_run_id IS NOT NULL
       AND (
         COALESCE(hris_status, 'Pending') <> 'Completed'
         OR COALESCE(paysheet_status, 'Pending') <> 'Completed'
         OR COALESCE(upload_status, 'Pending') <> 'Completed'
       )
     GROUP BY external_run_id, period
     ORDER BY MAX(COALESCE(updated_at, created_at)) DESC, MAX(id) DESC
     LIMIT 1`
  );
}

async function resetInterruptedProcessingRows(runId) {
  await runDb(
    `UPDATE automation_runs
     SET hris_status=CASE WHEN hris_status='Processing' THEN 'Pending' ELSE hris_status END,
         paysheet_status=CASE WHEN paysheet_status='Processing' THEN 'Pending' ELSE paysheet_status END,
         upload_status=CASE WHEN upload_status='Processing' THEN 'Pending' ELSE upload_status END,
         run_status='Running',
         updated_at=CURRENT_TIMESTAMP
     WHERE external_run_id=?`,
    [runId]
  );
}

async function listInterruptedDownloadRows(runId, runMonth) {
  const params = [runId];
  let monthClause = "";

  if (runMonth) {
    monthClause = "AND ar.period=?";
    params.push(runMonth);
  }

  return allDb(
    `SELECT
       ar.entity_id AS id,
       ar.entity_id,
       ar.company_id AS client_master_id,
       ar.company_code AS client_id,
       ar.company_name AS client_name,
       ar.company_code AS client_code,
       COALESCE(cm.status, 'ACTIVE') AS client_status,
       ar.entity_code,
       ar.period AS month,
       ar.period,
       ar.company_code || ':' || COALESCE(ar.entity_code, '001') AS common,
       COALESCE(ar.sftp_path, em.sftp_path, cm.sftp_path, '') AS sftp_path,
       COALESCE(ar.sftp_path, em.sftp_path, cm.sftp_path, '') AS file_path,
       ar.hris_filepath AS hrisFilePath,
       ar.paysheet_filepath AS paysheetFilePath,
       CASE
         WHEN COALESCE(ar.hris_status, 'Pending') = 'Completed' AND COALESCE(ar.paysheet_status, 'Pending') = 'Completed' THEN 'Downloaded'
         WHEN COALESCE(ar.hris_status, 'Pending') = 'Failed' OR COALESCE(ar.paysheet_status, 'Pending') = 'Failed' THEN 'Failed'
         ELSE COALESCE(ar.run_status, 'Pending')
       END AS status,
       COALESCE(ar.upload_status, 'Pending') AS uploadStatus,
       ar.updated_at,
       ar.created_at
     FROM automation_runs ar
     JOIN company_master cm ON cm.id = ar.company_id
     LEFT JOIN entity_master em ON em.id = ar.entity_id
     WHERE ar.external_run_id=?
       ${monthClause}
       AND (
         COALESCE(ar.hris_status, 'Pending') <> 'Completed'
         OR COALESCE(ar.paysheet_status, 'Pending') <> 'Completed'
       )
     ORDER BY ar.company_code, ar.entity_code, ar.id`,
    params
  );
}

// Live automation log stream. Each browser receives events until its connection closes.
app.get("/logs", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  res.write(`data: ${JSON.stringify({ type: "CONNECTED" })}\n\n`);
  streamClients.push(res);

  req.on("close", () => {
    streamClients = streamClients.filter((client) => client !== res);
  });
});

app.get("/logs/history", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const rows = await allDb(
      `SELECT id, run_id, level, event_type, client_id, client_name, entity_code, month, period, common, message, details, created_at
       FROM automation_logs
       ORDER BY id DESC
       LIMIT ?`,
      [limit]
    );
    res.json({ logs: rows });
  } catch (err) {
    sendErrorResponse(res, err, "Could not load automation logs.");
  }
});

app.post("/audit/log", async (req, res) => {
  try {
    await recordAuditLog(req.body || {});
    res.json({ success: true });
  } catch (err) {
    sendErrorResponse(res, err, "Could not save audit log.");
  }
});

app.get("/audit/logs", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 500, 5000);
    const rows = await allDb(
      `SELECT id, action, target, label, value, page, section, path, period, common, details, created_at
       FROM audit_logs
       ORDER BY id DESC
       LIMIT ?`,
      [limit]
    );
    res.json({ logs: rows });
  } catch (err) {
    sendErrorResponse(res, err, "Could not load audit logs.");
  }
});

app.get("/history", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 1000, 5000);
    const rows = await allDb(
      `SELECT id, run_id, company_id AS source_client_id, company_name AS client_name, company_code AS client_code, entity_code,
              COALESCE(period, month) AS month, COALESCE(period, month) AS period,
              common, COALESCE(file_path, sftp_path) AS file_path, COALESCE(file_path, sftp_path) AS sftp_path,
              COALESCE(hrisFilePath, hris_filepath) AS hrisFilePath, COALESCE(paysheetFilePath, paysheet_filepath) AS paysheetFilePath,
              status, uploadStatus, run_status, created_at, started_at, completed_at
       FROM automation_history
       ORDER BY completed_at DESC, id DESC
       LIMIT ?`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    sendErrorResponse(res, err, "Could not load automation history.");
  }
});

app.get("/settings", async (req, res) => {
  try {
    res.json(await loadRuntimeSettings());
  } catch (err) {
    sendErrorResponse(res, err, "Could not load settings.");
  }
});

app.post("/settings", async (req, res) => {
  try {
    const settings = await updateRuntimeSettings(req.body || {});
    res.json({ success: true, settings });
  } catch (err) {
    sendErrorResponse(res, err, "Could not save settings.");
  }
});

app.get("/network/status", async (req, res) => {
  const online = await checkNetworkReachability();
  res.json({
    online,
    host: NETWORK_CHECK_HOST
  });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}_${file.originalname}`);
    }
  }),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (![".xlsx", ".xls", ".csv"].includes(ext)) {
      cb(new Error("Only Excel or CSV files are allowed"));
      return;
    }
    cb(null, true);
  }
});

// Import company rows from an uploaded Excel/CSV file without replacing existing companies.
app.post("/upload", (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) {
      return sendErrorResponse(res, new AppError(err.message, 400), "File upload failed.");
    }

    if (!req.file) {
      return sendErrorResponse(res, new AppError("No file uploaded", 400), "No file uploaded.");
    }

    try {
      const excelData = readExcel(req.file.path);
      const duplicates = [];

      for (const client of excelData) {
        const existingClient = await getClientMaster(client.clientCode);
        const existing = existingClient
          ? await findEntityForClient(existingClient.id, client.entityCode)
          : null;

        if (existing) {
          duplicates.push({
            clientId: client.clientCode,
            clientName: client.clientName,
            entityCode: client.entityCode
          });
        }
      }

      if (duplicates.length) {
        return res.status(409).json({
          success: false,
          duplicate: true,
          error: "Duplicate company data found.",
          duplicates
        });
      }

      for (const client of excelData) {
        const clientMaster = await ensureClientMaster(client.clientCode, client.clientName);
        await runDb(
          `INSERT INTO entity_master
           (company_id, entity_code, entity_name, sftp_path, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            clientMaster.id,
            client.entityCode,
            `Entity ${client.entityCode}`,
            client.filePath
          ]
        );
      }

      send({ type: "UPLOAD_FILE_LOADED", total: excelData.length });
      res.json({ success: true, total: excelData.length, inserted: excelData.length });
    } catch (uploadErr) {
      sendErrorResponse(res, new AppError(uploadErr.message, 400), "Could not import company file.");
    } finally {
      safeUnlink(req.file?.path);
    }
  });
});

async function queueAutomationRun(runId, runMonth, reason) {
  return enqueueAutomationRun({
    runId,
    runMonth,
    reason,
    queuedAt: new Date().toISOString()
  });
}

async function runFullAutomation(rows, runId, runMonth) {
  let finalStatus = "Completed";
  let archived = false;

  try {
    send({ type: "AUTOMATION_STARTED", runId, month: runMonth });
    await runAutomation(rows.map((row) => mapAutomationClient(row, runMonth)));

    // Upload starts only after all requested downloads finish or the run is stopped.
    if (!global.automationStopRequested) {
      await uploadPaysheetBulk({ month: runMonth });
      send({ type: "AUTOMATION_COMPLETED", runId, month: runMonth });
    } else {
      finalStatus = "Stopped";
      send({ type: "AUTOMATION_STOPPED", runId, month: runMonth });
    }
  } catch (err) {
    finalStatus = "Failed";
    console.error("Automation failed:", err);
    send({ type: "AUTOMATION_ERROR", runId, month: runMonth, error: err.message });
  } finally {
    try {
      await archiveCurrentProcess(runId, finalStatus);
      archived = true;
    } catch (archiveErr) {
      console.error("Could not archive automation run:", archiveErr);
      send({ type: "AUTOMATION_ERROR", runId, month: runMonth, error: archiveErr.message });
    }

    if (archived && finalStatus === "Completed") {
      try {
        const backup = await createDatabaseBackup(runId);
        send({ type: "BACKUP_CREATED", runId, month: runMonth, backup: backup.name });
      } catch (backupErr) {
        console.error("Could not create database backup:", backupErr);
        send({ type: "BACKUP_FAILED", runId, month: runMonth, error: backupErr.message });
      }

      try {
        await cleanupTempFolder();
        send({ type: "TEMP_CLEANED", runId, month: runMonth });
      } catch (cleanupErr) {
        console.error("Could not clean temp folder:", cleanupErr);
        send({ type: "TEMP_CLEANUP_FAILED", runId, month: runMonth, error: cleanupErr.message });
      }
    }

    automationRunning = false;
    global.automationPauseRequested = false;
    global.currentRunId = null;
  }
}

async function processAutomationJob(job) {
  const runId = job.data?.runId;
  const runMonth = normalizeRunMonth(job.data?.runMonth);

  if (!runId) {
    throw new Error("Automation job is missing runId.");
  }

  if (automationRunning && global.currentRunId && global.currentRunId !== runId) {
    throw new Error(`Another automation run is active: ${global.currentRunId}`);
  }

  await resetInterruptedProcessingRows(runId);
  const remainingRows = await listInterruptedDownloadRows(runId, runMonth);

  automationRunning = true;
  global.automationStopRequested = false;
  global.automationPauseRequested = false;
  global.currentRunId = runId;

  await runFullAutomation(remainingRows, runId, runMonth);

  return {
    runId,
    month: runMonth,
    processedDownloads: remainingRows.length
  };
}

async function recoverInterruptedAutomation() {
  if (automationRunning) return;

  try {
    const interruptedRun = await getInterruptedRun();
    if (!interruptedRun?.run_id) return;

    const runId = interruptedRun.run_id;
    const runMonth = normalizeRunMonth(interruptedRun.month);

    await resetInterruptedProcessingRows(runId);
    const remainingRows = await listInterruptedDownloadRows(runId, runMonth);

    automationRunning = true;
    global.automationStopRequested = false;
    global.automationPauseRequested = false;
    global.currentRunId = runId;

    send({
      type: "AUTOMATION_RECOVERED",
      runId,
      month: runMonth,
      total: interruptedRun.total,
      remaining: remainingRows.length
    });

    await queueAutomationRun(runId, runMonth, "recovery");
  } catch (err) {
    automationRunning = false;
    global.automationPauseRequested = false;
    global.currentRunId = null;
    console.error("Could not recover interrupted automation:", err);
  }
}

// Start is fire-and-forget; live progress is reported through /logs.
app.post("/start", async (req, res) => {
  let runId = "";

  try {
    if (automationRunning) {
      return res.status(409).json({ success: false, error: "Automation already running" });
    }

    const rows = await listClientEntityRows(
      `WHERE COALESCE(cm.status, 'ACTIVE') = ?
         AND sp.id IS NULL`,
      ["ACTIVE"]
    );
    if (!rows.length) {
      return res.status(400).json({ success: false, error: "No active companies found outside Stop Process. Upload or release companies first." });
    }

    const runMonth = normalizeRunMonth(req.body?.month || req.query?.month || rows[0]?.month);
    if (!runMonth) {
      return res.status(400).json({ success: false, error: "Select a run month before starting automation." });
    }

    runId = createRunId();
    await startCurrentProcess(runId, runMonth);

    automationRunning = true;
    global.automationStopRequested = false;
    global.automationPauseRequested = false;
    global.currentRunId = runId;
    await queueAutomationRun(runId, runMonth, "start");

    res.json({ success: true, message: "Automation started", runId, month: runMonth, total: rows.length });
  } catch (err) {
    automationRunning = false;
    global.automationPauseRequested = false;
    global.currentRunId = null;

    if (runId) {
      await archiveCurrentProcess(runId, "Failed").catch((archiveErr) => {
        console.error("Could not archive failed queued run:", archiveErr.message);
      });
    }

    sendErrorResponse(res, err, "Could not start automation.");
  }
});

app.post("/stop", (req, res) => {
  global.automationStopRequested = true;
  global.automationPauseRequested = false;
  send({ type: "STOP_REQUESTED" });
  res.json({ success: true, message: "Stop requested" });
});

app.post("/pause", (req, res) => {
  if (!automationRunning) {
    return res.status(409).json({ success: false, error: "Automation is not running" });
  }
  global.automationPauseRequested = true;
  send({ type: "PAUSE_REQUESTED" });
  res.json({ success: true, message: "Pause requested" });
});

app.post("/resume", (req, res) => {
  if (!automationRunning) {
    return res.status(409).json({ success: false, error: "Automation is not running" });
  }
  global.automationPauseRequested = false;
  send({ type: "RESUME_REQUESTED" });
  res.json({ success: true, message: "Automation resumed" });
});

app.get("/status", (req, res) => {
  res.json({
    running: automationRunning,
    runId: global.currentRunId,
    stopRequested: Boolean(global.automationStopRequested),
    pauseRequested: Boolean(global.automationPauseRequested)
  });
});

app.get("/queue/status", async (req, res) => {
  try {
    res.json(await getAutomationQueueStatus());
  } catch (err) {
    sendErrorResponse(
      res,
      new AppError("Could not retrieve automation queue status.", 500, {
        cause: publicErrorMessage(err)
      })
    );
  }
});


app.get('/stop-process', async (req, res) => {
  try {
    const rows = await listStoppedProcessRows();
    res.json(rows);
  } catch (err) {
    sendErrorResponse(res, err, 'Could not load stop process list.');
  }
});

app.post('/stop-process', async (req, res) => {
  try {
    const companyId = Number(req.body?.companyId);
    const rawEntityCode = cleanText(req.body?.entityCode || '');
    const doneBy = cleanText(req.body?.doneBy || req.body?.modifiedBy || 'UI') || 'UI';

    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({ error: 'Valid company is required.' });
    }

    const company = await getDb('SELECT id, company_name AS client_name, company_code AS client_id, company_code AS client_code FROM company_master WHERE id=?', [companyId]);
    if (!company) {
      return res.status(404).json({ error: 'Company not found.' });
    }

    const normalizedEntityCode = rawEntityCode || '001';
    const entity = await getDb(
      `SELECT id FROM entity_master WHERE company_id=? AND lower(COALESCE(entity_code, ''))=lower(?) LIMIT 1`,
      [companyId, normalizedEntityCode]
    );

    if (!entity) {
      return res.status(400).json({ error: 'Selected entity does not exist for this company.' });
    }

    await runDb(
      `INSERT OR IGNORE INTO stop_process (company_id, entity_code, done_by) VALUES (?, ?, ?)`,
      [companyId, normalizedEntityCode, doneBy]
    );

    const rows = await listStoppedProcessRows();
    res.status(201).json({ success: true, rows });
  } catch (err) {
    sendErrorResponse(res, err, 'Could not save stop process record.');
  }
});

app.delete('/stop-process/:id', async (req, res) => {
  try {
    await runDb('DELETE FROM stop_process WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    sendErrorResponse(res, err, 'Could not release stop process record.');
  }
});

// Client CRUD powers the Clients and Config screens in the frontend.
app.get("/clients", async (req, res) => {
  try {
    const rows = await listClientEntityRows();
    res.json(rows);
  } catch (err) {
    sendErrorResponse(res, err, "Could not load companies.");
  }
});

app.post("/clients", async (req, res) => {
  try {
    const client = getValidatedClientRecord(req.body || {});
    const clientMaster = await ensureClientMaster(client.clientCode, client.clientName);
    const existingEntity = await findEntityForClient(clientMaster.id, client.entityCode);
    if (existingEntity) {
      return res.status(409).json({ error: "Entity already exists for this company." });
    }

    const result = await runDb(
      `INSERT INTO entity_master
       (company_id, entity_code, entity_name, sftp_path, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        clientMaster.id,
        client.entityCode,
        `Entity ${client.entityCode}`,
        client.filePath
      ]
    );

    const row = await getClientEntityRow(result.lastID);
    res.status(201).json(row);
  } catch (err) {
    sendErrorResponse(res, err, "Could not add company.");
  }
});

app.patch("/clients/:id/status", async (req, res) => {
  try {
    const entityId = req.params.id;
    const statusText = String(req.body?.status || "").trim().toUpperCase();
    const nextStatus = statusText === "STOPPED" ? "STOPPED" : "ACTIVE";

    const entity = await getDb("SELECT * FROM entity_master WHERE id=?", [entityId]);
    if (!entity) return res.status(404).json({ error: "Entity not found" });

    await runDb(
      `UPDATE company_master
       SET status=?, is_active=CASE WHEN ?='ACTIVE' THEN 1 ELSE 0 END, updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
      [nextStatus, nextStatus, entity.company_id]
    );

    const row = await getClientEntityRow(entityId);
    res.json(row);
  } catch (err) {
    sendErrorResponse(res, err, "Could not update client status.");
  }
});

app.put("/clients/:id", async (req, res) => {
  try {
    const client = getValidatedClientRecord(req.body || {});
    const currentEntity = await getDb("SELECT * FROM entity_master WHERE id=?", [req.params.id]);
    if (!currentEntity) return res.status(404).json({ error: "Entity not found" });

    const clientMaster = await ensureClientMaster(client.clientCode, client.clientName);
    await runDb(
      `UPDATE entity_master
       SET company_id=?, entity_code=?, entity_name=?, sftp_path=?, updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
      [
        clientMaster.id,
        client.entityCode,
        `Entity ${client.entityCode}`,
        client.filePath,
        req.params.id
      ]
    );

    await deleteClientMasterIfOrphan(currentEntity.company_id);
    const row = await getClientEntityRow(req.params.id);
    res.json(row);
  } catch (err) {
    sendErrorResponse(res, err, "Could not update company.");
  }
});

app.delete("/clients/:id", async (req, res) => {
  try {
    const entity = await getDb("SELECT * FROM entity_master WHERE id=?", [req.params.id]);
    if (!entity) return res.status(404).json({ error: "Entity not found" });
    await runDb("DELETE FROM entity_master WHERE id=?", [req.params.id]);
    await deleteClientMasterIfOrphan(entity.company_id);
    res.json({ success: true });
  } catch (err) {
    sendErrorResponse(res, err, "Could not delete company.");
  }
});

app.post('/client-config', async (req, res) => {
  try {
    const config = getValidatedClientConfiguration(req.body || {});
    const existingClient = await getClientMaster(config.clientCode);
    if (existingClient) {
      return res.status(409).json({ error: 'Company already exists. Use update instead.' });
    }

    const clientMaster = await ensureClientMaster(config.clientCode, config.clientName);
    await replaceClientEntities(clientMaster, config, 'UI');
    res.status(201).json(await getClientConfiguration(config.clientCode));
  } catch (err) {
    sendErrorResponse(res, err, 'Could not add company configuration.');
  }
});

app.put('/client-config/:clientId', async (req, res) => {
  try {
    const currentClient = await getClientMaster(req.params.clientId);
    if (!currentClient) return res.status(404).json({ error: 'Company not found' });

    const config = getValidatedClientConfiguration(req.body || {});
    const conflictingClient = await getClientMaster(config.clientCode);
    if (conflictingClient && conflictingClient.id !== currentClient.id) {
      return res.status(409).json({ error: 'Another company already uses this Company ID.' });
    }

    const clientMaster = await ensureClientMaster(config.clientCode, config.clientName);
    if (clientMaster.id !== currentClient.id) {
      await runDb(
        `UPDATE entity_master
         SET company_id=?, updated_at=CURRENT_TIMESTAMP
         WHERE company_id=?`,
        [clientMaster.id, currentClient.id]
      );
      await runDb('DELETE FROM company_master WHERE id=?', [currentClient.id]);
    }

    await replaceClientEntities(clientMaster, config, 'UI');
    res.json(await getClientConfiguration(config.clientCode));
  } catch (err) {
    sendErrorResponse(res, err, 'Could not update company configuration.');
  }
});

app.delete('/client-config/:clientId', async (req, res) => {
  try {
    const clientMaster = await getClientMaster(req.params.clientId);
    if (!clientMaster) return res.status(404).json({ error: 'Company not found' });

    await runDb('DELETE FROM entity_master WHERE company_id=?', [clientMaster.id]);
    await runDb('DELETE FROM company_master WHERE id=?', [clientMaster.id]);
    res.json({ success: true });
  } catch (err) {
    sendErrorResponse(res, err, 'Could not delete company configuration.');
  }
});

// Retry endpoints enqueue one-client automation work without blocking the UI request.
app.post("/retry/download", async (req, res) => {
  try {
    const clientCode = req.body?.clientCode;
    const entityCode = req.body?.entityCode || "";
    const month = req.body?.month || "";
    const row = entityCode
      ? await findEntityByBusinessKey(clientCode, entityCode, month)
      : await getDb(
        `${clientEntitySelect}
         WHERE lower(COALESCE(cm.company_code, ''))=lower(?)
         ORDER BY em.id
         LIMIT 1`,
        [clientCode]
      );
    if (!row) return res.status(404).json({ success: false, error: "Company not found" });

    global.automationStopRequested = false;
    runAutomation([mapAutomationClient(row)]).catch((err) => {
      console.error("Retry download failed:", err);
      send({ type: "FAILED", client: clientCode, error: err.message });
    });

    res.json({ success: true, message: "Retry download started" });
  } catch (err) {
    sendErrorResponse(res, err, "Could not retry download.");
  }
});

app.post("/retry/upload", async (req, res) => {
  try {
    const clientCode = req.body?.clientCode;
    const entityCode = req.body?.entityCode || "";
    const month = req.body?.month || "";
    global.automationStopRequested = false;
    uploadPaysheetBulk({ clientCode, entityCode, month }).catch((err) => {
      console.error("Retry upload failed:", err);
      send({ type: "UPLOAD_FAILED", client: clientCode, error: err.message });
    });

    res.json({ success: true, message: "Retry upload started" });
  } catch (err) {
    sendErrorResponse(res, err, "Could not retry upload.");
  }
});

function getSqlVerb(query) {
  return String(query || "").trim().match(/^([A-Za-z]+)/)?.[1]?.toLowerCase() || "";
}

function hasMultipleSqlStatements(query) {
  const withoutTrailingSemicolon = String(query || "").trim().replace(/;\s*$/, "");
  return withoutTrailingSemicolon.includes(";");
}

function splitSqlStatements(script) {
  const text = String(script || "");
  const statements = [];
  let current = "";
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (lineComment) {
      current += char;
      if (char === "\n") lineComment = false;
      continue;
    }

    if (blockComment) {
      current += char;
      if (char === "*" && next === "/") {
        current += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }

    if (!quote && char === "-" && next === "-") {
      current += char + next;
      index += 1;
      lineComment = true;
      continue;
    }

    if (!quote && char === "/" && next === "*") {
      current += char + next;
      index += 1;
      blockComment = true;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) {
        if (next === quote && quote !== "`") {
          current += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (["'", '"', "`"].includes(char)) {
      quote = char;
      current += char;
      continue;
    }

    if (char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}

async function executeSqlStatement(query) {
  const verb = getSqlVerb(query);

  if (["select", "pragma", "with", "explain"].includes(verb)) {
    const rows = await allDb(query);
    const columns = await getColumnsForQuery(query, rows);
    return {
      rows,
      columns,
      statementType: "read",
      summaryRow: { statement: verb.toUpperCase(), result: `${rows.length} row(s)` }
    };
  }

  if (["insert", "update", "delete", "replace"].includes(verb)) {
    const result = await runDb(query);
    return {
      rows: [{ result: `${verb.toUpperCase()} executed`, changes: result.changes || 0 }],
      columns: ["result", "changes"],
      statementType: "write",
      changes: result.changes || 0,
      summaryRow: { statement: verb.toUpperCase(), result: `${result.changes || 0} row(s) changed` }
    };
  }

  await execDb(query);
  return {
    rows: [{ result: `${verb ? verb.toUpperCase() : "SQL"} executed` }],
    columns: ["result"],
    statementType: "write",
    summaryRow: { statement: verb ? verb.toUpperCase() : "SQL", result: "Executed" }
  };
}

// SQL console endpoint. Supports full SQL scripts from the UI, including
// multi-statement execution for admin maintenance tasks.
app.post("/db/query", async (req, res) => {
  try {
    const query = String(req.body?.query || "").trim();
    if (!query) return res.json({ rows: [] });

    const statements = splitSqlStatements(query);
    if (!statements.length) return res.json({ rows: [] });

    const firstVerb = getSqlVerb(statements[0]);
    const hasMutation = statements.some((statement) => !["select", "pragma", "with", "explain"].includes(getSqlVerb(statement)));

    if (hasMutation && req.body?.confirmWrite !== true) {
      return res.status(400).json({ error: "Confirm this SQL script before executing." });
    }

    if (statements.length === 1) {
      const result = await executeSqlStatement(statements[0]);
      return res.json(result);
    }

    const summaryRows = [];
    for (const statement of statements) {
      const result = await executeSqlStatement(statement);
      summaryRows.push(result.summaryRow || { statement: getSqlVerb(statement).toUpperCase(), result: "Executed" });
    }

    res.json({
      rows: summaryRows,
      columns: ["statement", "result"],
      statementType: hasMutation ? "write" : "read",
      script: true,
      totalStatements: statements.length,
      firstVerb
    });
  } catch (err) {
    sendErrorResponse(res, err, "Could not execute SQL query.");
  }
});

app.get("/db/tables", async (req, res) => {
  try {
    const rows = await allDb("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const tables = rows.map((row) => ({ table_name: row.name }));
    res.json({ tables });
  } catch (err) {
    sendErrorResponse(res, err, "Could not list database tables.");
  }
});

app.get("/backups", async (req, res) => {
  try {
    res.json({ backups: await listDatabaseBackups() });
  } catch (err) {
    sendErrorResponse(res, err, "Could not list database backups.");
  }
});

app.post("/backups", async (req, res) => {
  try {
    const backup = await createDatabaseBackup(req.body?.runId || "manual");
    res.json({ success: true, backup });
  } catch (err) {
    sendErrorResponse(res, err, "Could not create database backup.");
  }
});

app.post("/backups/restore", async (req, res) => {
  try {
    if (automationRunning) {
      throw new AppError("Stop automation before restoring a database backup.", 409);
    }

    const result = await restoreDatabaseBackup(req.body?.name);
    send({ type: "BACKUP_RESTORED", backup: result.name });
    res.json({ success: true, ...result });
  } catch (err) {
    sendErrorResponse(res, err, "Could not restore database backup.");
  }
});

app.get("*", (req, res, next) => {
  const indexFile = path.join(__dirname, "../Frontend/dist/index.html");
  if (fs.existsSync(indexFile)) {
    res.sendFile(indexFile);
    return;
  }
  next();
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  sendErrorResponse(res, err, "Unexpected server error.");
});

app.listen(PORT, () => {
  console.log(`Backend server running at http://localhost:${PORT}`);
  recoverInterruptedAutomation();
});

async function shutdown(signal) {
  console.log(`${signal} received. Shutting down.`);
  await closeAutomationQueue();
  process.exit(0);
}

process.on("SIGINT", () => {
  shutdown("SIGINT").catch(() => process.exit(1));
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error("Unhandled promise rejection:", err);
  send({
    type: "AUTOMATION_ERROR",
    error: "Unexpected backend issue detected.",
    supportMessage: SUPPORT_MESSAGE,
    details: { reason: err.message }
  });
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught backend exception:", err);
  automationRunning = false;
  global.automationPauseRequested = false;
  send({
    type: "AUTOMATION_ERROR",
    error: "Unexpected backend crash detected.",
    supportMessage: SUPPORT_MESSAGE,
    details: { reason: err.message }
  });
});
