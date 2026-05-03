// Backend API entry point.
// Coordinates client ingestion, automation commands, live log streaming, and
// lightweight database access used by the React UI.
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const dns = require("dns").promises;

const db = require("./config/database");
const {
  closeAutomationQueue,
  enqueueAutomationRun,
  getAutomationQueueStatus,
  startAutomationWorker
} = require("./config/automation-queue");
const { loadRuntimeSettings, updateRuntimeSettings } = require("./config/runtime-settings");
const { runAutomation } = require("./automation/download-paysheet");
const { readExcel } = require("./services/excel-service");
const { cleanText, normalizeAndValidateClientRecord, titleCaseWords } = require("./services/client-normalizer");
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
    e.id,
    e.id AS entity_id,
    c.id AS client_master_id,
    COALESCE(c.client_id, c.client_code, e.client_id, e.client_code) AS client_id,
    c.client_name,
    COALESCE(c.client_id, c.client_code, e.client_id, e.client_code) AS client_code,
    e.entity_code,
    e.month,
    COALESCE(e.period, e.month) AS period,
    e.common,
    e.sftp_path,
    e.file_path,
    e.hrisFilePath,
    e.paysheetFilePath,
    e.status,
    e.uploadStatus,
    e.modified_by,
    e.updated_at,
    e.created_at
  FROM entities e
  JOIN clients c ON c.id = e.client_ref_id
`;

async function listClientEntityRows(where = "", params = []) {
  return allDb(
    `${clientEntitySelect}
     ${where}
     ORDER BY COALESCE(c.client_name, c.client_id, c.client_code), e.entity_code, e.id`,
    params
  );
}

async function getClientEntityRow(entityId) {
  return getDb(`${clientEntitySelect} WHERE e.id=?`, [entityId]);
}

async function getClientMaster(clientId) {
  return getDb(
    `SELECT *
     FROM clients
     WHERE lower(COALESCE(client_id, client_code, ''))=lower(?)
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
    if (normalizedClientName && normalizedClientName !== existing.client_name) {
      await runDb(
    `UPDATE clients
         SET client_id=?, client_code=?, client_name=?, common=?, modified_by='UI', updated_at=CURRENT_TIMESTAMP
         WHERE id=?`,
        [normalizedClientId, normalizedClientId, normalizedClientName, normalizedClientId, existing.id]
      );
      return { ...existing, client_id: normalizedClientId, client_code: normalizedClientId, client_name: normalizedClientName };
    }
    return existing;
  }

  const result = await runDb(
    `INSERT INTO clients
     (client_id, client_name, client_code, entity_code, month, period, common, sftp_path, file_path, status, uploadStatus, modified_by, updated_at)
     VALUES (?, ?, ?, '', '', '', ?, '', '', 'Pending', 'Pending', 'UI', CURRENT_TIMESTAMP)`,
    [normalizedClientId, normalizedClientName, normalizedClientId, normalizedClientId]
  );

  return getDb("SELECT * FROM clients WHERE id=?", [result.lastID]);
}

async function findEntityForClient(clientRefId, entityCode) {
  return getDb(
    `SELECT *
     FROM entities
     WHERE client_ref_id=?
       AND lower(COALESCE(entity_code, ''))=lower(?)
     LIMIT 1`,
    [clientRefId, entityCode]
  );
}

async function findEntityByBusinessKey(clientId, entityCode, month = "") {
  const params = [clientId, clientId, entityCode];
  let monthFilter = "";
  if (month) {
    monthFilter = " AND COALESCE(e.month, '') = ?";
    params.push(month);
  }

  return getDb(
    `${clientEntitySelect}
     WHERE (lower(COALESCE(c.client_id, ''))=lower(?) OR lower(COALESCE(c.client_code, ''))=lower(?))
       AND lower(COALESCE(e.entity_code, ''))=lower(?)
       ${monthFilter}
     ORDER BY e.id
     LIMIT 1`,
    params
  );
}

async function deleteClientMasterIfOrphan(clientRefId) {
  const countRow = await getDb("SELECT COUNT(*) AS total FROM entities WHERE client_ref_id=?", [clientRefId]);
  if (!countRow?.total) {
    await runDb("DELETE FROM clients WHERE id=?", [clientRefId]);
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
  if (type === "QUEUE_JOB_ACTIVE") return `BullMQ started automation job ${message.jobId || ""}`.trim();
  if (type === "QUEUE_JOB_COMPLETED") return `BullMQ completed automation job ${message.jobId || ""}`.trim();
  if (type === "QUEUE_JOB_FAILED") return `BullMQ failed automation job ${message.jobId || ""}: ${message.error || "Unknown error"}`.trim();
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

async function startCurrentProcess(runId) {
  await runDb("DELETE FROM current_process");
  await runDb(
    `INSERT INTO current_process
     (run_id, source_client_id, client_name, client_code, entity_code, month, period, common, file_path,
      hrisFilePath, paysheetFilePath, status, uploadStatus, run_status, created_at, started_at)
     SELECT ?, e.id, c.client_name, COALESCE(c.client_id, c.client_code, e.client_id, e.client_code),
            e.entity_code, e.month, COALESCE(e.period, e.month),
            COALESCE(e.common, COALESCE(c.client_id, c.client_code, e.client_id, e.client_code, '') || ':' || COALESCE(e.entity_code, '')),
            COALESCE(e.sftp_path, e.file_path),
            e.hrisFilePath, e.paysheetFilePath, e.status, e.uploadStatus, 'Running',
            e.created_at, CURRENT_TIMESTAMP
     FROM entities e
     JOIN clients c ON c.id = e.client_ref_id
     ORDER BY c.id, e.id`,
    [runId]
  );
}

async function archiveCurrentProcess(runId, finalStatus) {
  await runDb(
    `INSERT INTO automation_history
     (run_id, source_client_id, client_name, client_code, entity_code, month, period, common, file_path,
      hrisFilePath, paysheetFilePath, status, uploadStatus, run_status, created_at, started_at, completed_at)
     SELECT run_id, source_client_id, client_name, client_code, entity_code, month, period, common, file_path,
            hrisFilePath, paysheetFilePath, status, uploadStatus, ?, created_at, started_at, CURRENT_TIMESTAMP
     FROM current_process
     WHERE run_id=?`,
    [finalStatus, runId]
  );
  await runDb("DELETE FROM current_process WHERE run_id=?", [runId]);
}

async function getInterruptedRun() {
  return getDb(
    `SELECT run_id, month, COUNT(*) AS total
     FROM current_process
     WHERE run_id IS NOT NULL
     GROUP BY run_id, month
     ORDER BY MAX(started_at) DESC, MAX(id) DESC
     LIMIT 1`
  );
}

async function resetInterruptedProcessingRows(runId) {
  await runDb(
    `UPDATE entities
     SET status='Pending', updated_at=CURRENT_TIMESTAMP
     WHERE id IN (
       SELECT source_client_id
       FROM current_process
       WHERE run_id=?
     )
       AND status='Processing'`,
    [runId]
  );

  await runDb(
    `UPDATE entities
     SET uploadStatus='Pending', updated_at=CURRENT_TIMESTAMP
     WHERE id IN (
       SELECT source_client_id
       FROM current_process
       WHERE run_id=?
     )
       AND uploadStatus='Processing'`,
    [runId]
  );
}

async function listInterruptedDownloadRows(runId, runMonth) {
  const params = [runId];
  let monthClause = "";

  if (runMonth) {
    monthClause = "AND e.month=?";
    params.push(runMonth);
  }

  return listClientEntityRows(
    `WHERE e.id IN (
       SELECT source_client_id
       FROM current_process
       WHERE run_id=?
     )
       ${monthClause}
       AND (
         COALESCE(e.status, 'Pending') IN ('Pending', 'Processing')
         OR e.hrisFilePath IS NULL
         OR e.paysheetFilePath IS NULL
       )`,
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
      `SELECT id, run_id, source_client_id, client_name, client_code, entity_code, month,
              COALESCE(period, month) AS period, common, file_path, file_path AS sftp_path,
              hrisFilePath, paysheetFilePath, status, uploadStatus,
              run_status, created_at, started_at, completed_at
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
          `INSERT INTO entities
           (client_ref_id, client_id, client_code, entity_code, month, period, common, sftp_path, file_path, status, uploadStatus, modified_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [
            clientMaster.id,
            client.clientCode,
            client.clientCode,
            client.entityCode,
            "",
            "",
            `${client.clientCode}:${client.entityCode}`,
            client.filePath,
            client.filePath,
            "Pending",
            "Pending",
            "Excel Upload"
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
  let job;
  try {
    job = await enqueueAutomationRun({
      runId,
      runMonth,
      reason,
      queuedAt: new Date().toISOString()
    });
  } catch (err) {
    throw new AppError(
      `Automation queue is unavailable. Start Redis and try again. ${publicErrorMessage(err, "")}`.trim(),
      503,
      { redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379" }
    );
  }

  send({
    type: "QUEUE_JOB_QUEUED",
    runId,
    month: runMonth,
    jobId: job.id,
    reason
  });

  return job;
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
    throw new Error("BullMQ automation job is missing runId.");
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

    const rows = await listClientEntityRows();
    if (!rows.length) {
      return res.status(400).json({ success: false, error: "No companies found. Upload or add companies first." });
    }

    const runMonth = normalizeRunMonth(req.body?.month || req.query?.month || rows[0]?.month);
    if (!runMonth) {
      return res.status(400).json({ success: false, error: "Select a run month before starting automation." });
    }

    await runDb(
      `UPDATE entities
       SET month=?,
           period=?,
           common=COALESCE(common, COALESCE(client_id, client_code, '') || ':' || COALESCE(entity_code, '')),
           hrisFilePath=NULL,
           paysheetFilePath=NULL,
           status='Pending',
           uploadStatus='Pending',
           modified_by='Automation',
           updated_at=CURRENT_TIMESTAMP`,
      [runMonth, runMonth]
    );

    runId = createRunId();
    await startCurrentProcess(runId);

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
      new AppError("Redis is not reachable. Start Redis before running automation.", 503, {
        redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
        cause: publicErrorMessage(err)
      })
    );
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
      `INSERT INTO entities
       (client_ref_id, client_id, client_code, entity_code, month, period, common, sftp_path, file_path, status, uploadStatus, modified_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        clientMaster.id,
        client.clientCode,
        client.clientCode,
        client.entityCode,
        client.month,
        normalizeRunMonth(client.month),
        `${client.clientCode}:${client.entityCode}`,
        client.filePath,
        client.filePath,
        normalizeStatus(client.status),
        normalizeStatus(client.uploadStatus),
        "UI"
      ]
    );

    const row = await getClientEntityRow(result.lastID);
    res.status(201).json(row);
  } catch (err) {
    sendErrorResponse(res, err, "Could not add company.");
  }
});

app.put("/clients/:id", async (req, res) => {
  try {
    const client = getValidatedClientRecord(req.body || {});
    const currentEntity = await getDb("SELECT * FROM entities WHERE id=?", [req.params.id]);
    if (!currentEntity) return res.status(404).json({ error: "Entity not found" });

    const clientMaster = await ensureClientMaster(client.clientCode, client.clientName);
    await runDb(
      `UPDATE entities
       SET client_ref_id=?, client_id=?, client_code=?, entity_code=?, month=?, period=?, common=?, sftp_path=?, file_path=?, status=?, uploadStatus=?, modified_by='UI', updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
      [
        clientMaster.id,
        client.clientCode,
        client.clientCode,
        client.entityCode,
        client.month,
        normalizeRunMonth(client.month),
        `${client.clientCode}:${client.entityCode}`,
        client.filePath,
        client.filePath,
        normalizeStatus(client.status),
        normalizeStatus(client.uploadStatus),
        req.params.id
      ]
    );

    await deleteClientMasterIfOrphan(currentEntity.client_ref_id);
    const row = await getClientEntityRow(req.params.id);
    res.json(row);
  } catch (err) {
    sendErrorResponse(res, err, "Could not update company.");
  }
});

app.delete("/clients/:id", async (req, res) => {
  try {
    const entity = await getDb("SELECT * FROM entities WHERE id=?", [req.params.id]);
    if (!entity) return res.status(404).json({ error: "Entity not found" });
    await runDb("DELETE FROM entities WHERE id=?", [req.params.id]);
    await deleteClientMasterIfOrphan(entity.client_ref_id);
    res.json({ success: true });
  } catch (err) {
    sendErrorResponse(res, err, "Could not delete company.");
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
         WHERE lower(COALESCE(c.client_id, c.client_code, ''))=lower(?)
         ORDER BY e.id
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

// SQL console endpoint. Reads run directly; writes require the frontend's
// explicit confirmation flag so accidental deletes do not execute silently.
app.post("/db/query", async (req, res) => {
  try {
    const query = String(req.body?.query || "").trim();
    if (!query) return res.json({ rows: [] });

    if (hasMultipleSqlStatements(query)) {
      return res.status(400).json({ error: "Run one SQL statement at a time." });
    }

    const verb = getSqlVerb(query);
    if (["select", "pragma"].includes(verb)) {
      const rows = await allDb(query);
      const columns = await getColumnsForQuery(query, rows);
      res.json({ rows, columns, statementType: "read" });
      return;
    }

    if (!["delete", "update", "insert"].includes(verb)) {
      return res.status(400).json({ error: "Only SELECT, PRAGMA, INSERT, UPDATE, and DELETE queries are allowed from the UI." });
    }

    if (req.body?.confirmWrite !== true) {
      return res.status(400).json({ error: "Confirm this write query before executing." });
    }

    const result = await runDb(query);
    res.json({
      rows: [{ result: `${verb.toUpperCase()} executed`, changes: result.changes || 0 }],
      columns: ["result", "changes"],
      changes: result.changes || 0,
      statementType: "write"
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
  startAutomationWorker(processAutomationJob, {
    active: (job) => {
      send({
        type: "QUEUE_JOB_ACTIVE",
        jobId: job.id,
        runId: job.data?.runId,
        month: job.data?.runMonth
      });
    },
    completed: (job) => {
      send({
        type: "QUEUE_JOB_COMPLETED",
        jobId: job.id,
        runId: job.data?.runId,
        month: job.data?.runMonth
      });
    },
    failed: (job, err) => {
      automationRunning = false;
      global.automationPauseRequested = false;
      global.currentRunId = null;
      send({
        type: "QUEUE_JOB_FAILED",
        jobId: job?.id,
        runId: job?.data?.runId,
        month: job?.data?.runMonth,
        error: err.message
      });
    }
  });
  recoverInterruptedAutomation();
});

async function shutdown(signal) {
  console.log(`${signal} received. Closing automation queue.`);
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
