// Client/event utilities shared by the dashboard screens.
// These helpers translate backend event payloads into frontend display state.
export function getMonthYearOptions() {
  const formatter = new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric"
  });
  const now = new Date();
  const presentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const pastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  return [pastMonth, presentMonth].map((date) => {
    const label = formatter.format(date).toUpperCase();
    return {
      label,
      value: label
    };
  });
}

export function normalizeRunMonth(value) {
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

  return raw;
}

export function getClientRowKey(clientCode, entityCode = "", month = "") {
  return [clientCode || "", entityCode || "", month || ""]
    .map((value) => String(value).trim().toUpperCase())
    .join("::");
}

export function emptyClient(clientCode, defaults = {}) {
  const entityCode = defaults.entityCode || "-";
  const month = defaults.month || "-";
  return {
    rowKey: defaults.rowKey || getClientRowKey(clientCode, entityCode, month),
    entityId: defaults.entityId || defaults.id || "",
    clientCode,
    clientName: defaults.clientName || defaults.client_name || defaults.name || clientCode,
    entityCode,
    month,
    sftpPath: defaults.sftpPath || defaults.sftp_path || defaults.file_path || "-",
    filePath: defaults.filePath || "-",
    createdAt: defaults.createdAt || "-",
    rawStatus: defaults.rawStatus || "Pending",
    hrisStatus: defaults.hrisStatus || defaults.downloadStatus || "PENDING",
    paysheetStatus: defaults.paysheetStatus || defaults.downloadStatus || "PENDING",
    downloadStatus: defaults.downloadStatus || "PENDING",
    uploadStatus: defaults.uploadStatus || "PENDING"
  };
}

// Normalize Server-Sent Events into the client status model used by Live Run.
export function normalizeEvent(data, previous) {
  if (!data.client) return previous;
  const entityCode = data.entity || data.entityCode || "-";
  const month = data.month || "-";
  const rowKey = data.rowKey || getClientRowKey(data.client, entityCode, month);
  const current = previous[rowKey] || emptyClient(data.client, {
    rowKey,
    clientName: data.clientName || data.client_name || data.name,
    entityCode,
    month
  });
  const next = { ...current, rowKey, clientCode: data.client, entityCode, month };
  const sourcePath = data.sftpPath || data.sftp_path || data.sourcePath;
  if (sourcePath) next.sftpPath = sourcePath;

  if (data.type === "START") {
    next.hrisStatus = next.hrisStatus === "SUCCESS" ? "SUCCESS" : "PROCESSING";
    next.paysheetStatus = next.paysheetStatus === "SUCCESS" ? "SUCCESS" : "PENDING";
    next.downloadStatus = "PROCESSING";
    next.uploadStatus = next.uploadStatus || "PENDING";
  } else if (data.type === "HRIS_SUCCESS") {
    next.hrisStatus = "SUCCESS";
    next.paysheetStatus = next.paysheetStatus === "SUCCESS" ? "SUCCESS" : "PROCESSING";
    next.downloadStatus = "PROCESSING";
    next.filePath = data.hrisPath || next.filePath;
  } else if (data.type === "PAYSHEET_SUCCESS") {
    next.paysheetStatus = "SUCCESS";
    next.downloadStatus = next.hrisStatus === "SUCCESS" ? "SUCCESS" : "PROCESSING";
    next.filePath = data.paysheetPath || next.filePath;
  } else if (data.type === "SUCCESS") {
    next.hrisStatus = "SUCCESS";
    next.paysheetStatus = "SUCCESS";
    next.downloadStatus = "SUCCESS";
    next.filePath = data.paysheetPath || data.filePath || next.filePath;
    if (next.uploadStatus === "PENDING") next.uploadStatus = "PROCESSING";
  } else if (data.type === "FAILED") {
    if (data.stage === "PAYSHEET") {
      next.hrisStatus = "SUCCESS";
      next.paysheetStatus = "FAILED";
    } else {
      next.hrisStatus = "FAILED";
      next.paysheetStatus = next.paysheetStatus === "SUCCESS" ? "SUCCESS" : "PENDING";
    }
    next.downloadStatus = "FAILED";
  } else if (data.type === "UPLOAD_START") {
    next.uploadStatus = "PROCESSING";
  } else if (data.type === "UPLOADED") {
    next.uploadStatus = "SUCCESS";
  } else if (data.type === "UPLOAD_FAILED") {
    next.uploadStatus = "FAILED";
  }

  return { ...previous, [rowKey]: next };
}

export function formatLogMessage(data) {
  if (data.type === "CONNECTED") return "";
  if (data.type === "AUTOMATION_STARTED") return "Automation started";
  if (data.type === "AUTOMATION_COMPLETED") return "Automation completed";
  if (data.type === "AUTOMATION_STOPPED") return "Automation stopped";
  if (data.type === "STOP_REQUESTED") return "Stop requested; current company will finish first";
  if (data.type === "PAUSE_REQUESTED") return "Pause requested; current company will finish first";
  if (data.type === "RESUME_REQUESTED") return "Automation resumed";
  if (data.type === "UPLOAD_FILE_LOADED") return `Loaded ${data.total || 0} companies from uploaded file`;
  if (data.type === "AUTOMATION_ERROR") return `Automation error: ${data.error || "Unknown error"}`;
  if (data.type === "BACKUP_CREATED") return `Database backup created: ${data.backup || "backup"}`;
  if (data.type === "BACKUP_FAILED") return `Database backup failed: ${data.error || "Unknown error"}`;
  if (data.type === "BACKUP_RESTORED") return `Database backup restored: ${data.backup || "backup"}`;
  if (data.type === "TEMP_CLEANED") return "Temporary download folders cleaned";
  if (data.type === "TEMP_CLEANUP_FAILED") return `Temporary folder cleanup failed: ${data.error || "Unknown error"}`;
  if (data.type === "START") return `Started processing company ${data.client}`;
  if (data.type === "HRIS_SUCCESS") return `HRIS downloaded for company ${data.client}`;
  if (data.type === "PAYSHEET_SUCCESS") return `Paysheet downloaded for company ${data.client}`;
  if (data.type === "SUCCESS") return `Download completed for company ${data.client}`;
  if (data.type === "FAILED") return `Download failed for company ${data.client}`;
  if (data.type === "UPLOAD_START") return `Upload started for company ${data.client}`;
  if (data.type === "UPLOADED") return `Uploaded to destination for company ${data.client}`;
  if (data.type === "UPLOAD_FAILED") return `Upload failed for company ${data.client}`;
  return "Event received";
}

export function formatStoredLog(row) {
  const timestamp = row.created_at
    ? new Date(row.created_at).toLocaleTimeString()
    : "";
  const level = row.level ? row.level.toUpperCase() : "INFO";
  const period = normalizeRunMonth(row.period || row.month);
  const periodPart = period ? ` [${period}]` : "";
  const runId = row.run_id ? ` [${row.run_id}]` : "";
  const client = row.client_id ? ` (${row.client_id})` : "";
  return `${timestamp} - ${level}${periodPart}${runId}${client} - ${row.message || ""}`;
}

// Export the visible automation log as CSV for audit/reconciliation work.
export function downloadLogsCsv(logs, selectedMonthYear) {
  const escapeCsv = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const rows = [
    ["Period", "Timestamp", "Message"],
    ...logs.map((line) => {
      const parts = String(line).split(" - ");
      const timestamp = parts.shift() || "";
      return [selectedMonthYear, timestamp, parts.join(" - ") || ""];
    })
  ];
  const csv = rows.map((row) => row.map(escapeCsv).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `automation-log-${selectedMonthYear.toLowerCase().replace(/\s+/g, "-")}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
