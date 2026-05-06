// Main React application shell.
// Owns dashboard state, coordinates API calls, and renders the operational views
// used to upload client lists, run automation, inspect clients, and manage config.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { FixedSizeList as List } from "react-window";
import { Icon } from "./components/Icon.jsx";
import { defaultConfig, emptyClientConfigForm, tabs, toolbarTabs } from "./config/navigation.js";
import { downloadLogsCsv, emptyClient, formatLogMessage, formatStoredLog, getClientRowKey, getMonthYearOptions, normalizeEvent, normalizeRunMonth } from "./utils/client-events.js";

const cleanInputText = (value) => String(value ?? "").trim();

const titleCaseClientName = (value) => cleanInputText(value).replace(/\b([A-Za-z])([A-Za-z]*)/g, (_, first, rest) => (
  `${first.toUpperCase()}${rest.toLowerCase()}`
));

const createEmptyEntityRow = () => ({
  id: `entity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  entity_code: "",
  sftp_path: "",
  file_path: "",
  status: "Pending"
});

const normalizeClientConfigForm = (form = {}) => {
  const clientId = cleanInputText(form.client_id || form.client_code);
  const sftpPath = cleanInputText(form.sftp_path || form.file_path);
  const hasEntities = Boolean(form.has_entities);
  const entities = Array.isArray(form.entities) && form.entities.length
    ? form.entities.map((entity, index) => {
      const entityPath = cleanInputText(entity.sftp_path || entity.file_path);
      return {
        id: entity.id || `entity-${index + 1}`,
        entity_code: cleanInputText(entity.entity_code),
        sftp_path: entityPath,
        file_path: entityPath,
        status: cleanInputText(entity.status) || "Pending"
      };
    })
    : [createEmptyEntityRow()];

  return {
    ...form,
    id: form.id ?? "",
    client_group_key: form.client_group_key || clientId,
    client_id: clientId,
    client_code: clientId,
    client_name: titleCaseClientName(form.client_name),
    entity_code: hasEntities ? cleanInputText(form.entity_code) : "001",
    month: cleanInputText(form.month),
    has_entities: hasEntities,
    sftp_path: sftpPath,
    file_path: sftpPath,
    status: cleanInputText(form.status) || "Pending",
    uploadStatus: cleanInputText(form.uploadStatus || form.upload_status || "Pending") || "Pending",
    entityTab: hasEntities ? (form.entityTab === "entities" ? "entities" : "company") : "company",
    entities
  };
};

const validateClientConfigForm = (form, requireSelected = false) => {
  if (requireSelected && !form.client_group_key) return "Select a company row to update.";
  if (!form.client_id) return "Company ID is required.";
  if (!form.client_name) return "Company Name is required.";

  if (!form.has_entities) {
    if (!form.sftp_path) return "SFTP Path is required.";
    if (!form.sftp_path.includes("/")) return "SFTP Path must contain at least one forward slash (/).";
    return "";
  }

  if (!form.entities?.length) return "Add at least one entity.";

  const seen = new Set();
  for (let index = 0; index < form.entities.length; index += 1) {
    const entity = form.entities[index];
    const label = `Entity ${index + 1}`;

    if (!entity.entity_code) return `${label}: Entity Code is required.`;
    if (!/^\d{3}$/.test(entity.entity_code)) return `${label}: Entity Code must be exactly three digits.`;
    if (seen.has(entity.entity_code)) return `${label}: Entity Code must be unique.`;
    seen.add(entity.entity_code);
    if (!entity.sftp_path) return `${label}: SFTP Path is required.`;
    if (!entity.sftp_path.includes("/")) return `${label}: SFTP Path must contain at least one forward slash (/).`;
  }

  return "";
};

const buildClientConfigPayload = (form) => ({
  clientCode: form.client_id,
  clientName: form.client_name,
  month: form.month,
  status: form.status,
  uploadStatus: form.uploadStatus,
  hasEntities: Boolean(form.has_entities),
  filePath: form.sftp_path,
  entities: Boolean(form.has_entities)
    ? form.entities.map((entity) => ({
      entityCode: entity.entity_code,
      filePath: entity.sftp_path,
      status: entity.status || "Pending"
    }))
    : []
});

const formatColumnLabel = (column) => {
  const labels = {
    client_id: "Company ID",
    client_code: "Company ID",
    company_id: "Company ID",
    client_name: "Company Name",
    company_name: "Company Name",
    entity_code: "Entity Code",
    sftp_path: "SFTP Path",
    file_path: "File Path",
    month: "Period",
    period: "Period",
    common: "Common",
    modified_by: "Modified By",
    updated_at: "Modified On",
    created_at: "Added On"
  };
  return labels[column] || String(column || "").replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
};

const escapeRegExp = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getDefaultMonthYearValue = () => {
  const options = getMonthYearOptions();
  return options[0]?.value || "";
};

const isNoEntityDefaultCode = (value) => cleanInputText(value) === "001";
const hasRealEntityRows = (rows = []) => {
  const entityRows = rows.filter((item) => cleanInputText(item.entity_code));
  if (entityRows.length === 0) return false;
  if (entityRows.length === 1 && isNoEntityDefaultCode(entityRows[0].entity_code)) return false;
  return true;
};


const getLiveRailHeight = (viewportHeight) => Math.max(760, viewportHeight - 92);

const AUTH_STORAGE_KEY = "paysheetAutomationSession";
const AUTH_USERS_STORAGE_KEY = "paysheetAutomationUsers";
const DEFAULT_AUTH_USERS = {
  user: { username: "user", password: "user" },
  admin: { username: "admin", password: "admin" }
};

const readStoredSession = () => {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (!stored) return null;
    const session = JSON.parse(stored);
    if (!session?.username || !["user", "admin"].includes(session.role)) return null;
    return session;
  } catch {
    return null;
  }
};

const readAuthUsers = () => {
  if (typeof window === "undefined") return DEFAULT_AUTH_USERS;
  try {
    const stored = window.localStorage.getItem(AUTH_USERS_STORAGE_KEY);
    if (!stored) return DEFAULT_AUTH_USERS;
    const parsed = JSON.parse(stored);
    return {
      admin: {
        username: parsed?.admin?.username || parsed?.admin?.email || DEFAULT_AUTH_USERS.admin.username,
        password: parsed?.admin?.password || DEFAULT_AUTH_USERS.admin.password
      },
      user: {
        username: parsed?.user?.username || parsed?.user?.email || DEFAULT_AUTH_USERS.user.username,
        password: parsed?.user?.password || DEFAULT_AUTH_USERS.user.password
      }
    };
  } catch {
    return DEFAULT_AUTH_USERS;
  }
};

const saveAuthUsers = (users) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(AUTH_USERS_STORAGE_KEY, JSON.stringify(users));
};

const formatDisplayDateTime = (value) => {
  if (!value) return "-";
  return String(value).replace("T", " ").slice(0, 19);
};

function App() {
  const [authUser, setAuthUser] = useState(readStoredSession);
  const [usersStatus, setUsersStatus] = useState("");
  const isLoggedIn = Boolean(authUser);
  const isAdmin = authUser?.role === "admin";

  // Core operational state loaded from backend events and the clients database.
  const [clients, setClients] = useState({});
  const [dbRecords, setDbRecords] = useState([]);
  const [historyRecords, setHistoryRecords] = useState([]);
  const [stopProcessRecords, setStopProcessRecords] = useState([]);
  const [stopProcessForm, setStopProcessForm] = useState({ companyId: '', entityCode: '' });
  const [stopProcessStatus, setStopProcessStatus] = useState('');
  const [activeTab, setActiveTab] = useState(() => localStorage.getItem("activeTab") || "live");
  const [liveSearch, setLiveSearch] = useState("");
  const [companiesSearch, setCompaniesSearch] = useState("");
  const [liveFilter, setLiveFilter] = useState("all");
  const [logs, setLogs] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [currentClient, setCurrentClient] = useState("-");
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [isNavOpen, setIsNavOpen] = useState(false);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [isStartConfirmOpen, setIsStartConfirmOpen] = useState(false);
  const [isStopConfirmOpen, setIsStopConfirmOpen] = useState(false);
  const [isAutomationRunning, setIsAutomationRunning] = useState(false);
  const [isAutomationPaused, setIsAutomationPaused] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [uploadFeedback, setUploadFeedback] = useState(null);
  const [backendAlert, setBackendAlert] = useState(null);
  const [networkWarning, setNetworkWarning] = useState(false);
  const [networkConnected, setNetworkConnected] = useState(false);
  const [pendingLoads, setPendingLoads] = useState(0);
  const [loadingMessage, setLoadingMessage] = useState("Loading...");
  const [showLoadingSpinner, setShowLoadingSpinner] = useState(false);

  // Config access is intentionally separate from SFTP settings credentials.
  const [isConfigAuthOpen, setIsConfigAuthOpen] = useState(false);
  const [configAuth, setConfigAuth] = useState({ user: "", pass: "" });
  const [configAuthError, setConfigAuthError] = useState("");

  // Frontend configuration state. At present this is in-memory only.
  const [config, setConfig] = useState(defaultConfig);
  const [configStatus, setConfigStatus] = useState("");
  const [historyMonth, setHistoryMonth] = useState("");
  const [historyYear, setHistoryYear] = useState("");
  const [historyCompany, setHistoryCompany] = useState("");
  const [selectedMonthYear, setSelectedMonthYear] = useState(getDefaultMonthYearValue);
  const [isMonthMenuOpen, setIsMonthMenuOpen] = useState(false);
  const [sqlQuery, setSqlQuery] = useState("");
  const [dbResultRows, setDbResultRows] = useState([]);
  const [dbResultColumns, setDbResultColumns] = useState([]);
  const [clientConfigSearch, setClientConfigSearch] = useState("");
  const [clientConfigForm, setClientConfigForm] = useState(emptyClientConfigForm);
  const [clientConfigStatus, setClientConfigStatus] = useState("");
  const [configSection, setConfigSection] = useState("clientConfig");
  const queryAbortRef = useRef(null);
  const fileInputRef = useRef(null);
  const auditContextRef = useRef({ activeTab: "live", configSection: "clientConfig" });
  const selectedRunMonth = useMemo(() => normalizeRunMonth(selectedMonthYear), [selectedMonthYear]);
  const stopProcessCompanies = useMemo(() => makeCompanyGroups(dbRecords), [dbRecords]);
  const stopProcessEntityOptions = useMemo(() => {
    const company = stopProcessCompanies.find((item) => String(item.rows[0]?.clientMasterId || item.rows[0]?.client_master_id || '') === String(stopProcessForm.companyId || ''));
    if (!company) return [];
    const rows = (company.rows || []).filter((row) => cleanInputText(row.entity_code));
    return rows.map((row) => ({
      value: row.entity_code || '001',
      label: row.entity_code || '001'
    }));
  }, [stopProcessCompanies, stopProcessForm.companyId]);
  const visibleTabs = useMemo(() => tabs.filter((tab) => isAdmin || !["config", "users"].includes(tab.id)), [isAdmin]);
  const visibleToolbarTabs = useMemo(() => toolbarTabs.filter((tab) => isAdmin || tab.id !== "config"), [isAdmin]);

  useEffect(() => {
    if (!pendingLoads) {
      setShowLoadingSpinner(false);
      return undefined;
    }

    const timer = window.setTimeout(() => setShowLoadingSpinner(true), 350);
    return () => window.clearTimeout(timer);
  }, [pendingLoads]);

  const withSpinner = async (message, task) => {
    setLoadingMessage(message || "Loading...");
    setPendingLoads((value) => value + 1);
    try {
      return await task();
    } finally {
      setPendingLoads((value) => Math.max(0, value - 1));
    }
  };

  const readBackendError = async (response, fallback) => {
    const data = await response?.json?.().catch(() => ({}));
    const message = data?.error || data?.message || fallback;
    const details = data?.details
      ? Object.entries(data.details).map(([key, value]) => `${key}: ${value}`)
      : [];
    return { message, details, supportMessage: data?.supportMessage || "" };
  };

  const showBackendAlert = (title, message, items = [], supportMessage = "") => {
    setBackendAlert({
      title: title || "Backend Error",
      message: message || "The backend could not complete the request.",
      items,
      supportMessage
    });
  };

  useEffect(() => {
    auditContextRef.current = { activeTab, configSection };
  }, [activeTab, configSection]);

  useEffect(() => {
    localStorage.setItem("activeTab", activeTab);
  }, [activeTab]);

  useEffect(() => {
    const sensitiveTypes = new Set(["password", "file"]);
    const getControlLabel = (element) => {
      if (!element) return "Unknown control";
      const label = element.getAttribute("data-audit-label")
        || element.getAttribute("aria-label")
        || element.getAttribute("placeholder")
        || element.name
        || element.id
        || element.textContent;
      const trimmed = String(label || "").replace(/\s+/g, " ").trim();
      if (trimmed) return trimmed.slice(0, 160);

      const labelElement = element.closest("label");
      if (labelElement) {
        return String(labelElement.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
      }

      return element.tagName ? element.tagName.toLowerCase() : "Unknown control";
    };

    const getSafeValue = (element) => {
      if (!element || sensitiveTypes.has(String(element.type || "").toLowerCase())) return "";
      if (element.tagName === "SELECT") {
        return element.options?.[element.selectedIndex]?.text || element.value || "";
      }
      if (element.type === "checkbox") return element.checked ? "checked" : "unchecked";
      if (element.type === "radio") return element.checked ? element.value : "";
      return "";
    };

    const sendAudit = (entry) => {
      const payload = JSON.stringify({
        ...entry,
        page: auditContextRef.current.activeTab,
        section: auditContextRef.current.configSection,
        path: window.location.pathname
      });

      if (navigator.sendBeacon) {
        navigator.sendBeacon("/audit/log", new Blob([payload], { type: "application/json" }));
        return;
      }

      fetch("/audit/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true
      }).catch(() => {});
    };

    const handleClick = (event) => {
      const target = event.target.closest("button, a, [role='button'], input[type='checkbox'], input[type='radio']");
      if (!target || target.closest("[data-audit-ignore='true']")) return;
      sendAudit({
        action: "click",
        target: target.tagName?.toLowerCase() || "control",
        label: getControlLabel(target),
        value: getSafeValue(target)
      });
    };

    const handleChange = (event) => {
      const target = event.target.closest("select, input[type='checkbox'], input[type='radio']");
      if (!target || target.closest("[data-audit-ignore='true']")) return;
      sendAudit({
        action: "change",
        target: target.tagName?.toLowerCase() || "control",
        label: getControlLabel(target),
        value: getSafeValue(target)
      });
    };

    document.addEventListener("click", handleClick, true);
    document.addEventListener("change", handleChange, true);
    return () => {
      document.removeEventListener("click", handleClick, true);
      document.removeEventListener("change", handleChange, true);
    };
  }, []);

  const isNotificationMessage = (message) => /failed|error|stopped|completed|started|pause|resume|unavailable|uploaded|loaded/i.test(String(message || ""));

  // Keep the in-memory log bounded so long-running sessions do not slow rendering.
  const addLog = (message, period = selectedRunMonth) => {
    const normalizedPeriod = normalizeRunMonth(period);
    const periodLabel = normalizedPeriod ? ` [${normalizedPeriod}]` : "";
    const line = `${new Date().toLocaleTimeString()} -${periodLabel} ${message}`;
    setLogs((items) => [line, ...items].slice(0, 200));
    if (isNotificationMessage(message)) {
      setNotifications((items) => [line, ...items].slice(0, 20));
    }
  };

  const checkNetworkStatus = async (showConnectedMessage = false) => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setNetworkWarning(true);
      return;
    }

    try {
      const res = await fetch("/network/status", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setNetworkWarning(!data.online);
      if (data.online && showConnectedMessage) {
        setNetworkConnected(true);
        window.setTimeout(() => setNetworkConnected(false), 2200);
      }
    } catch {
      setNetworkWarning(true);
    }
  };

  // Load current client rows from the backend database.
  const loadDbData = async (showSpinner = false) => {
    const load = async () => {
      try {
        const res = await fetch("/clients");
        if (!res.ok) throw new Error("No DB endpoint");
        const rows = await res.json();
        setDbRecords(Array.isArray(rows) ? rows : []);
        return Array.isArray(rows) ? rows : [];
      } catch {
        setDbRecords([]);
        return [];
      }
    };

    return showSpinner ? withSpinner("Loading companies...", load) : load();
  };

  const loadHistoryData = async (showSpinner = false) => {
    const load = async () => {
      try {
        const res = await fetch("/history");
        if (!res.ok) throw new Error("No history endpoint");
        const rows = await res.json();
        setHistoryRecords(Array.isArray(rows) ? rows : []);
        return Array.isArray(rows) ? rows : [];
      } catch {
        setHistoryRecords([]);
        return [];
      }
    };

    return showSpinner ? withSpinner("Loading history...", load) : load();
  };

  const loadStopProcessData = async (showSpinner = false) => {
    const load = async () => {
      try {
        const res = await fetch("/stop-process");
        if (!res.ok) throw new Error("No stop process endpoint");
        const rows = await res.json();
        setStopProcessRecords(Array.isArray(rows) ? rows : []);
        return Array.isArray(rows) ? rows : [];
      } catch {
        setStopProcessRecords([]);
        return [];
      }
    };

    return showSpinner ? withSpinner("Loading stop process list...", load) : load();
  };

  // Keep Live Run aligned with the latest database rows so add/update/delete in other tabs reflect immediately.
  const hydrateLiveFromDb = (rows) => {
    setClients((previous) => {
      const next = {};
      rows.forEach((row) => {
        const clientCode = row.client_id || row.client_code;
        if (!clientCode) return;
        const displayMonth = row.month || selectedRunMonth;
        const entityCode = row.entity_code || "-";
        const rowKey = getClientRowKey(clientCode, entityCode, displayMonth);
        const existing = previous[rowKey];
        const dbStatus = String(row.status || "").toUpperCase();
        const dbUploadStatus = String(row.uploadStatus || row.upload_status || "").toUpperCase();
        const hrisStatus = row.hrisFilePath
          ? "SUCCESS"
          : dbStatus.includes("FAIL")
            ? "FAILED"
            : dbStatus.includes("PROCESS")
              ? "PROCESSING"
              : "PENDING";
        const paysheetStatus = row.paysheetFilePath
          ? "SUCCESS"
          : dbStatus.includes("FAIL")
            ? "FAILED"
            : row.hrisFilePath && dbStatus.includes("PROCESS")
              ? "PROCESSING"
              : "PENDING";
        const resolvedDownloadStatus = hrisStatus === "SUCCESS" && paysheetStatus === "SUCCESS"
          ? "SUCCESS"
          : hrisStatus === "FAILED" || paysheetStatus === "FAILED"
            ? "FAILED"
            : hrisStatus === "PROCESSING" || paysheetStatus === "PROCESSING"
              ? "PROCESSING"
              : "PENDING";
        const record = existing || emptyClient(clientCode, {
          rowKey,
          entityId: row.entity_id || row.id,
          clientName: row.client_name || row.clientName || row.name,
          entityCode,
          month: displayMonth,
          sftpPath: row.sftp_path || row.file_path,
          filePath: row.paysheetFilePath || row.sftp_path || row.file_path,
          createdAt: row.created_at,
          rawStatus: row.status,
          hrisStatus,
          paysheetStatus,
          downloadStatus: resolvedDownloadStatus
        });
        next[rowKey] = {
          ...record,
          rowKey,
          entityId: row.entity_id || row.id || record.entityId,
          clientCode,
          clientName: row.client_name || record.clientName,
          entityCode,
          month: displayMonth,
          sftpPath: row.sftp_path || row.file_path || record.sftpPath,
          filePath: row.paysheetFilePath || row.sftp_path || row.file_path || record.filePath,
          rawStatus: row.status || record.rawStatus,
          hrisStatus,
          paysheetStatus,
          downloadStatus: resolvedDownloadStatus || record.downloadStatus,
          uploadStatus: dbUploadStatus.includes("FAIL")
            ? "FAILED"
            : dbUploadStatus.includes("UPLOAD") || dbUploadStatus.includes("SUCCESS")
              ? "SUCCESS"
              : dbUploadStatus.includes("PROCESS")
                ? "PROCESSING"
                : dbUploadStatus.includes("PENDING")
                  ? "PENDING"
                  : record.uploadStatus
        };
      });
      return next;
    });
  };

  useEffect(() => {
    if (!isLoggedIn) return;
    withSpinner("Loading dashboard...", async () => {
      const rows = await loadDbData();
      hydrateLiveFromDb(rows);
      await loadHistoryData();
      await loadStopProcessData();
    });
  }, [isLoggedIn]);

  useEffect(() => {
    if (!isLoggedIn) return undefined;
    checkNetworkStatus();

    const handleOnline = () => checkNetworkStatus(true);
    const handleOffline = () => setNetworkWarning(true);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [isLoggedIn]);

  useEffect(() => {
    if (!isLoggedIn) return;
    const loadSettings = async () => {
      await withSpinner("Loading settings...", async () => {
        try {
          const res = await fetch("/settings");
          if (!res.ok) return;
          const settings = await res.json();
          setConfig((value) => ({
            ...value,
            sftpUrl: settings.sftpUrl ?? value.sftpUrl,
            sftpUser: settings.sftpUser ?? value.sftpUser,
            sftpPass: settings.sftpPass ?? value.sftpPass,
            vistaHeadless: Boolean(settings.vistaHeadless),
            sftpHeadless: Boolean(settings.sftpHeadless)
          }));
        } catch {
          // Settings are optional at startup; defaults keep the UI usable.
        }
      });
    };

    loadSettings();
  }, [isLoggedIn]);

  useEffect(() => {
    if (!isLoggedIn) return;
    const loadSavedLogs = async () => {
      await withSpinner("Loading logs...", async () => {
        try {
          const res = await fetch("/logs/history?limit=500");
          if (!res.ok) throw new Error("Log history unavailable");
          const data = await res.json();
          const rows = Array.isArray(data.logs) ? data.logs : [];
          setLogs(rows.map(formatStoredLog));
        } catch {
          addLog("Saved logs are unavailable.");
        }
      });
    };

    loadSavedLogs();
  }, [isLoggedIn]);

  // Subscribe to backend Server-Sent Events for real-time automation progress.
  useEffect(() => {
    if (!isLoggedIn) return undefined;
    let source;
    try {
      source = new EventSource("/logs");
      source.onmessage = (event) => {
        let data = null;
        try {
          data = JSON.parse(event.data);
        } catch {
          addLog(event.data);
          return;
        }
        if (data?.type === "CONNECTED") return;
        if (data?.client && data.type === "START") setCurrentClient(data.client);
        if (data?.type === "AUTOMATION_STARTED") {
          setIsAutomationRunning(true);
          setIsAutomationPaused(false);
        }
        if (data?.type === "AUTOMATION_ERROR" || data?.type === "QUEUE_JOB_FAILED") {
          showBackendAlert(
            "Automation Error",
            data.error || "Automation failed. Check logs for details.",
            data.details ? Object.entries(data.details).map(([key, value]) => `${key}: ${value}`) : [],
            data.supportMessage || ""
          );
        }
        if (["AUTOMATION_COMPLETED", "AUTOMATION_STOPPED", "AUTOMATION_ERROR"].includes(data?.type)) {
          setIsAutomationRunning(false);
          setIsAutomationPaused(false);
          window.setTimeout(loadHistoryData, 1000);
        }
        if (data?.type === "PAUSE_REQUESTED") {
          setIsAutomationRunning(true);
          setIsAutomationPaused(true);
        }
        if (data?.type === "RESUME_REQUESTED") {
          setIsAutomationRunning(true);
          setIsAutomationPaused(false);
        }
        setClients((previous) => normalizeEvent(data, previous));
        const message = formatLogMessage(data);
        if (message) addLog(message, data?.month);
      };
    } catch {
      addLog("Live log stream is unavailable.");
    }
    return () => source?.close();
  }, [isLoggedIn]);

  // Derived metrics are memoized because client status changes can be frequent.
  const clientRows = useMemo(() => Object.values(clients), [clients]);
  const stats = useMemo(() => {
    const total = clientRows.length;
    const success = clientRows.filter((r) => r.hrisStatus === "SUCCESS" && r.paysheetStatus === "SUCCESS" && r.uploadStatus === "SUCCESS").length;
    const failed = clientRows.filter((r) => r.hrisStatus === "FAILED" || r.paysheetStatus === "FAILED" || r.uploadStatus === "FAILED").length;
    const processing = clientRows.filter((r) => r.hrisStatus === "PROCESSING" || r.paysheetStatus === "PROCESSING" || r.uploadStatus === "PROCESSING").length;
    return { total, success, failed, processing, completed: success + failed };
  }, [clientRows]);
  const progressPercent = stats.total === 0 ? 0 : Math.round((stats.completed / stats.total) * 100);
  const runFinished = stats.total > 0 && stats.completed >= stats.total && !isAutomationRunning;
  const uploadHasStarted = clientRows.some((row) => {
    const uploadStatus = String(row.uploadStatus || "").toUpperCase();
    return ["PROCESSING", "SUCCESS", "FAILED"].includes(uploadStatus);
  });
  const activeRunStep = uploadHasStarted ? 2 : 1;

  const filteredLiveRows = useMemo(() => {
    const keyword = liveSearch.trim().toLowerCase();
    return clientRows.filter((item) => {
      const isFailed = item.hrisStatus === "FAILED" || item.paysheetStatus === "FAILED" || item.uploadStatus === "FAILED";
      const isProcessed = !["PENDING", "PROCESSING"].includes(item.hrisStatus) && !["PENDING", "PROCESSING"].includes(item.paysheetStatus) && !["PENDING", "PROCESSING"].includes(item.uploadStatus);
      if (liveFilter === "failed" && !isFailed) return false;
      if (liveFilter === "processed" && !isProcessed) return false;
      if (!keyword) return true;
      return `${item.clientCode} ${item.clientName} ${item.entityCode} ${item.month} ${item.hrisStatus} ${item.paysheetStatus} ${item.uploadStatus} ${item.sftpPath || ""} ${item.filePath || ""}`.toLowerCase().includes(keyword);
    });
  }, [clientRows, liveFilter, liveSearch]);

  const filteredDbRows = useMemo(() => {
    const keyword = companiesSearch.trim().toLowerCase();
    return dbRecords.filter((item) => {
      if (!keyword) return true;
      return `${item.client_name || ""} ${item.client_id || ""} ${item.client_code || ""} ${item.entity_code || ""} ${item.month || ""} ${item.status || ""} ${item.uploadStatus || ""} ${item.sftp_path || ""} ${item.file_path || ""}`.toLowerCase().includes(keyword);
    });
  }, [dbRecords, companiesSearch]);

  const years = useMemo(() => {
    const values = new Set();
    historyRecords.forEach((row) => {
      const match = String(row.period || row.month || "").match(/\d{4}/);
      if (match) values.add(match[0]);
    });
    return Array.from(values).sort();
  }, [historyRecords]);
  const historyMonths = useMemo(() => Array.from(new Set(historyRecords.map((row) => row.period || row.month).filter(Boolean))).sort(), [historyRecords]);
  const historyCompanyOptions = useMemo(() => {
    const options = new Map();
    historyRecords.forEach((row) => {
      const companyName = String(row.client_name || "").trim();
      const companyId = String(row.client_code || row.client_id || "").trim();
      if (!companyName && !companyId) return;
      const key = JSON.stringify([companyId, companyName]);
      const label = `${companyName || "-"}${companyId ? ` (${companyId})` : ""}`;
      options.set(key, { key, label });
    });
    return Array.from(options.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [historyRecords]);

  const historyRows = useMemo(() => {
    return historyRecords.filter((row) => {
      const value = String(row.period || row.month || "");
      const company = String(row.client_name || "").trim();
      const companyId = String(row.client_code || row.client_id || "").trim();
      const companyKey = JSON.stringify([companyId, company]);
      if (historyMonth && value !== historyMonth) return false;
      if (historyYear && !value.includes(historyYear)) return false;
      if (historyCompany && companyKey !== historyCompany) return false;
      return true;
    });
  }, [historyRecords, historyMonth, historyYear, historyCompany]);
  const showDashboardSummary = visibleToolbarTabs.some((tab) => tab.id === activeTab);

  const filteredCompanyRows = useMemo(() => {
    const keyword = companiesSearch.trim().toLowerCase();
    return dbRecords.filter((row) => {
      if (!keyword) return true;
      return `${row.client_name || ""} ${row.client_id || ""} ${row.client_code || ""} ${row.entity_code || ""} ${row.sftp_path || ""} ${row.file_path || ""}`.toLowerCase().includes(keyword);
    });
  }, [companiesSearch, dbRecords]);

  // Config and Companies use independent search state so tabs do not affect each other.
  const filteredClientConfigRows = useMemo(() => {
    const keyword = clientConfigSearch.trim().toLowerCase();
    const companyMap = new Map();

    dbRecords.forEach((row) => {
      const key = row.client_id || row.client_code || "";
      if (!key) return;

      const code = cleanInputText(row.entity_code);
      const existing = companyMap.get(key);
      const nextEntityCodes = new Set(existing?.entity_codes || []);
      if (code) nextEntityCodes.add(code);
      const realEntityCodes = Array.from(nextEntityCodes).filter((item) => item && item !== "001");
      const hasEntities = realEntityCodes.length > 0 || nextEntityCodes.size > 1;
      const entityCodeDisplay = hasEntities
        ? (realEntityCodes.length > 1 ? realEntityCodes.join(", ") : (realEntityCodes[0] || Array.from(nextEntityCodes)[0] || "-"))
        : "001";

      const normalizedRow = {
        ...(existing || row),
        ...row,
        client_group_key: key,
        client_master_id: row.client_master_id || existing?.client_master_id || row.id,
        entity_codes: Array.from(nextEntityCodes),
        entity_code: entityCodeDisplay,
        entity_code_display: entityCodeDisplay,
        has_entities: hasEntities,
        sftp_path: hasEntities ? "" : (row.sftp_path || row.file_path || existing?.sftp_path || existing?.file_path || ""),
        file_path: hasEntities ? "" : (row.sftp_path || row.file_path || existing?.sftp_path || existing?.file_path || ""),
        updated_at: row.updated_at || existing?.updated_at,
        created_at: existing?.created_at || row.created_at
      };

      companyMap.set(key, normalizedRow);
    });

    return Array.from(companyMap.values()).filter((row) => {
      if (!keyword) return true;
      return `${row.client_name || ""} ${row.client_id || ""} ${row.client_code || ""} ${row.entity_code_display || ""} ${row.sftp_path || ""} ${row.file_path || ""}`.toLowerCase().includes(keyword);
    });
  }, [clientConfigSearch, dbRecords]);

  const selectTab = (tabId) => {
    if (["config", "users"].includes(tabId) && !isAdmin) {
      return;
    }
    setActiveTab(tabId);
    setIsNavOpen(false);
    if (tabId === "sftp") openSftpPortal();
    if (tabId === "clients") refreshClientConfig("", true);
    if (tabId === "history") loadHistoryData(true);
    if (tabId === "stopProcess") loadStopProcessData(true);
  };

  const login = ({ username, role }) => {
    const session = {
      username: cleanInputText(username),
      role,
      signedInAt: new Date().toISOString()
    };
    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
    setAuthUser(session);
    setActiveTab("live");
    setIsNavOpen(false);
  };

  const logout = () => {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
    setAuthUser(null);
    setActiveTab("live");
    setIsNavOpen(false);
    setIsMonthMenuOpen(false);
  };

  const showAllHistory = () => {
    setHistoryMonth("");
    setHistoryYear("");
    setHistoryCompany("");
  };

  const selectRunMonth = (value) => {
    const runMonth = normalizeRunMonth(value);
    setSelectedMonthYear(value);
    setClients((previous) => {
      const next = {};
      Object.values(previous).forEach((client) => {
        const rowKey = getClientRowKey(client.clientCode, client.entityCode, runMonth || client.month);
        next[rowKey] = {
          ...client,
          rowKey,
          month: runMonth || client.month
        };
      });
      return next;
    });
    setSelectedRecord((record) => record ? { ...record, month: runMonth || record.month } : record);
  };

  // Opens the configured SFTP portal in a separate browser tab.
  const openSftpPortal = () => {
    const url = (config.sftpUrl || "").trim();
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  // Starts the backend automation run. Progress updates arrive through /logs.
  const startAutomation = async () => {
    addLog("Starting automation...");
    setIsStartConfirmOpen(false);
    setIsAutomationRunning(true);
    setIsAutomationPaused(false);
    await withSpinner("Starting automation...", async () => {
      try {
      const response = await fetch("/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month: selectedMonthYear })
      });
      if (!response?.ok) {
        const error = await readBackendError(response, "Could not start automation.");
        addLog(error.message);
        setIsAutomationRunning(false);
        setIsAutomationPaused(false);
        showBackendAlert("Could Not Start Automation", error.message, error.details, error.supportMessage);
      }
      else {
        setIsAutomationRunning(true);
        addLog(`Automation started for ${selectedMonthYear}.`);
      }
      } catch (err) {
        const message = err.message || "Could not start automation.";
        addLog(message);
        setIsAutomationRunning(false);
        setIsAutomationPaused(false);
        showBackendAlert("Could Not Start Automation", message);
      }
    });
  };

  const resumeAutomation = async () => {
    await withSpinner("Resuming automation...", async () => {
      try {
        const response = await fetch("/resume", { method: "POST" }).catch(() => fetch("/resume"));
        if (!response?.ok) {
          const error = await readBackendError(response, "Could not resume automation.");
          addLog(error.message);
          showBackendAlert("Could Not Resume", error.message, error.details, error.supportMessage);
          return;
        }
        setIsAutomationPaused(false);
        setIsAutomationRunning(true);
        addLog("Automation resumed.");
      } catch (err) {
        const message = err.message || "Could not resume automation.";
        addLog(message);
        showBackendAlert("Could Not Resume", message);
      }
    });
  };

  const pauseAutomation = async () => {
    await withSpinner("Pausing automation...", async () => {
      try {
        const response = await fetch("/pause", { method: "POST" }).catch(() => fetch("/pause"));
        if (!response?.ok) {
          const error = await readBackendError(response, "Could not pause automation.");
          addLog(error.message);
          showBackendAlert("Could Not Pause", error.message, error.details, error.supportMessage);
          return;
        }
        setIsAutomationPaused(true);
        setIsAutomationRunning(true);
        addLog("Pause requested by user. Current company will finish first.");
      } catch (err) {
        const message = err.message || "Could not pause automation.";
        addLog(message);
        showBackendAlert("Could Not Pause", message);
      }
    });
  };

  // Requests a graceful stop; automation modules poll the global stop flag.
  const stopAutomation = async () => {
    await withSpinner("Stopping automation...", async () => {
      try {
        const response = await fetch("/stop", { method: "POST" }).catch(() => fetch("/stop"));
        if (!response?.ok) {
          const error = await readBackendError(response, "Could not stop automation.");
          showBackendAlert("Could Not Stop", error.message, error.details, error.supportMessage);
          return;
        }
      } catch (err) {
        showBackendAlert("Could Not Stop", err.message || "Could not stop automation.");
        return;
      }
      setIsStopConfirmOpen(false);
      setIsAutomationRunning(true);
      setIsAutomationPaused(false);
      addLog("Stop requested by user. Current company will finish first.");
    });
  };

  const resetDashboard = () => {
    setClients({});
    setLogs([]);
    setNotifications([]);
    setCurrentClient("-");
    setSelectedRecord(null);
  };

  // Upload a client sheet, reload database records, and refresh the dashboard.
  const uploadFile = async () => {
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setUploadError("Please select a file.");
      return;
    }
    const allowed = [".xlsx", ".xls", ".csv"].some((ext) => file.name.toLowerCase().endsWith(ext));
    if (!allowed) {
      setUploadError("Only Excel/CSV files are allowed.");
      return;
    }

    const formData = new FormData();
    formData.append("file", file);

    await withSpinner("Uploading company file...", async () => {
      try {
        const res = await fetch("/upload", { method: "POST", body: formData });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setIsUploadOpen(false);
          setUploadError("");
          if (fileInputRef.current) fileInputRef.current.value = "";
          setUploadFeedback({
            type: "error",
            title: data.duplicate ? "Duplicate companies found" : "Check Excel file",
            message: data.error || "Check Excel file format and required columns.",
            items: Array.isArray(data.duplicates)
              ? data.duplicates.map((item) => `${item.clientId}${item.entityCode ? ` / ${item.entityCode}` : ""}${item.clientName ? ` - ${item.clientName}` : ""}`)
              : []
          });
          return;
        }
        setIsUploadOpen(false);
        setUploadError("");
        if (fileInputRef.current) fileInputRef.current.value = "";
        addLog(`Company file uploaded: ${file.name}`);
        setUploadFeedback({
          type: "success",
          title: "Companies uploaded",
          message: `${data.inserted || data.total || 0} companies stored in the database.`,
          items: []
        });
        resetDashboard();
        const rows = await loadDbData();
        hydrateLiveFromDb(rows);
      } catch {
        setIsUploadOpen(false);
        setUploadError("");
        setUploadFeedback({
          type: "error",
          title: "Check Excel file",
          message: "Server error during upload. Please check the Excel file and try again.",
          items: []
        });
      }
    });
  };

  // Retry actions run one client at a time and leave existing dashboard state intact.
  const retryAction = async (type, item) => {
    const clientCode = typeof item === "string" ? item : item.clientCode;
    const entityCode = typeof item === "string" ? "" : item.entityCode;
    const month = typeof item === "string" ? "" : item.month;
    const rowKey = typeof item === "string" ? item : item.rowKey || getClientRowKey(clientCode, entityCode, month);
    const endpoint = type === "download" ? "/retry/download" : "/retry/upload";
    await withSpinner(`Retrying ${type}...`, async () => {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientCode, entityCode, month })
        });
        if (!res.ok) {
          const error = await readBackendError(res, "Retry endpoint error");
          throw new Error(error.message);
        }
        addLog(`Retry requested for ${type} - ${clientCode}${entityCode ? ` / ${entityCode}` : ""}`);
        setClients((previous) => ({
          ...previous,
          [rowKey]: {
            ...previous[rowKey],
            ...(type === "download"
              ? { hrisStatus: "PROCESSING", paysheetStatus: "PENDING", downloadStatus: "PROCESSING", uploadStatus: "PENDING" }
              : { uploadStatus: "PROCESSING" })
          }
        }));
      } catch (err) {
        const message = err.message || `Retry API not available for ${type} (${clientCode}${entityCode ? ` / ${entityCode}` : ""}).`;
        addLog(message);
        showBackendAlert("Retry Failed", message);
      }
    });
  };

  // Collect the best live/database details for the side panel.
  const showRecordDetails = (item, source) => {
    const clientCode = typeof item === "string" ? item : item.clientCode;
    const entityCode = typeof item === "string" ? "" : item.entityCode;
    const month = typeof item === "string" ? "" : item.month;
    const rowKey = typeof item === "string" ? item : item.rowKey || getClientRowKey(clientCode, entityCode, month);
    const live = clients[rowKey] || clients[clientCode];
    const db = dbRecords.find((record) => {
      const recordClient = record.client_id || record.client_code;
      if (recordClient !== clientCode) return false;
      if (entityCode && record.entity_code !== entityCode) return false;
      if (month && record.month && record.month !== month) return false;
      return true;
    });
    setSelectedRecord({
      clientCode,
      clientName: live?.clientName || db?.client_name || "-",
      entityCode: live?.entityCode || db?.entity_code || "-",
      month: live?.month || db?.month || "-",
      hrisStatus: live?.hrisStatus || (db?.hrisFilePath ? "SUCCESS" : "-"),
      paysheetStatus: live?.paysheetStatus || (db?.paysheetFilePath ? "SUCCESS" : "-"),
      downloadStatus: live?.downloadStatus || "-",
      uploadStatus: live?.uploadStatus || "-",
      dbStatus: db?.status || live?.rawStatus || "-",
      filePath: db?.paysheetFilePath || db?.sftp_path || db?.file_path || live?.filePath || "-",
      createdAt: db?.created_at || live?.createdAt || "-",
      source
    });
  };

  // Execute SQL through the backend console endpoint. Supports full scripts,
  // including DDL statements like DROP/ALTER/CREATE and multiple statements.
  const executeSql = async () => {
    const query = sqlQuery.trim();
    if (!query) {
      setDbResultRows([]);
      setDbResultColumns([]);
      return;
    }
    const isWriteQuery = /(insert|update|delete|drop|alter|create|truncate|replace|vacuum|reindex|analyze|begin|commit|rollback)/i.test(query);
    if (isWriteQuery && !window.confirm("This SQL script can change or remove database objects and data. Execute it?")) {
      return;
    }
    queryAbortRef.current = new AbortController();
    await withSpinner(isWriteQuery ? "Executing SQL script..." : "Running query...", async () => {
      try {
        const res = await fetch("/db/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, confirmWrite: isWriteQuery }),
          signal: queryAbortRef.current.signal
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Query API unavailable");
        setDbResultRows(Array.isArray(data.rows) ? data.rows : []);
        setDbResultColumns(Array.isArray(data.columns) ? data.columns : []);
        if (data.statementType === "write") {
          await refreshClientConfig();
          await loadDbData();
          await loadHistoryData();
        }
      } catch (err) {
        setDbResultRows([{ error: err.message || "Query failed" }]);
        setDbResultColumns(["error"]);
      }
    });
  };

  // List SQLite tables without requiring the user to type PRAGMA/SELECT manually.
  const listTables = async () => {
    await withSpinner("Loading database tables...", async () => {
      try {
        const res = await fetch("/db/tables");
        if (!res.ok) throw new Error("Tables API unavailable");
        const data = await res.json();
        const tableRows = (data.tables || []).map((item) => (
          typeof item === "string"
            ? { table_name: item }
            : { table_name: item.table_name || item.name || String(item) }
        ));
        setDbResultRows(tableRows);
        setDbResultColumns(["table_name"]);
      } catch {
        setDbResultRows([{ table_name: "clients" }]);
        setDbResultColumns(["table_name"]);
      }
    });
  };

  const stopSql = () => {
    queryAbortRef.current?.abort();
    queryAbortRef.current = null;
  };

  // Validate Config access and land on Client Configuration after login.
  const openConfigAfterAuth = () => {
    if (!configAuth.user.trim() || !configAuth.pass.trim()) {
      setConfigAuthError("Username and password required.");
      return;
    }

    setConfig((value) => ({
      ...value,
      dbUser: configAuth.user.trim(),
      dbPass: configAuth.pass
    }));
    setIsConfigAuthOpen(false);
    setIsNavOpen(false);
    setActiveTab("config");
    setConfigSection("clientConfig");
    refreshClientConfig("", true);
  };

  const refreshClientConfig = async (message = "", showSpinner = false) => {
    const rows = await loadDbData(showSpinner);
    hydrateLiveFromDb(Array.isArray(rows) ? rows : []);
    if (message) setClientConfigStatus(message);
    return rows;
  };

  const addStopProcess = async () => {
    if (!stopProcessForm.companyId || !stopProcessForm.entityCode) {
      setStopProcessStatus('Select company and entity code.');
      return;
    }

    await withSpinner('Saving stop process...', async () => {
      try {
        const res = await fetch('/stop-process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            companyId: Number(stopProcessForm.companyId),
            entityCode: stopProcessForm.entityCode,
            doneBy: authUser?.username || authUser?.role || 'UI'
          })
        });
        if (!res.ok) {
          const error = await readBackendError(res, 'Could not save stop process.');
          setStopProcessStatus(error.message);
          return;
        }
        setStopProcessForm((previous) => ({ ...previous, entityCode: '' }));
        setStopProcessStatus('Stop process saved.');
        await loadStopProcessData();
      } catch {
        setStopProcessStatus('Could not save stop process.');
      }
    });
  };

  const removeStopProcess = async (id) => {
    await withSpinner('Releasing stop process...', async () => {
      try {
        const res = await fetch(`/stop-process/${id}`, { method: 'DELETE' });
        if (!res.ok) {
          const error = await readBackendError(res, 'Could not release stop process.');
          setStopProcessStatus(error.message);
          return;
        }
        setStopProcessStatus('Stop process released.');
        await loadStopProcessData();
      } catch {
        setStopProcessStatus('Could not release stop process.');
      }
    });
  };

  // Load a selected database row into the edit form without mutating the table.
  const selectClientConfigRow = (row) => {
    const groupKey = row.client_id || row.client_code || "";
    const groupedRows = dbRecords
      .filter((item) => (item.client_id || item.client_code || "") === groupKey)
      .sort((left, right) => String(left.entity_code || "").localeCompare(String(right.entity_code || "")));

    const hasEntities = hasRealEntityRows(groupedRows);
    const companyPath = (groupedRows.find((item) => !cleanInputText(item.entity_code) || isNoEntityDefaultCode(item.entity_code)) || groupedRows[0] || {}).sftp_path || (groupedRows.find((item) => !cleanInputText(item.entity_code) || isNoEntityDefaultCode(item.entity_code)) || groupedRows[0] || {}).file_path || "";

    setClientConfigForm(normalizeClientConfigForm({
      id: row.id ?? "",
      client_group_key: groupKey,
      client_id: groupKey,
      client_name: row.client_name || "",
      client_code: groupKey,
      month: row.month || "",
      has_entities: hasEntities,
      entityTab: hasEntities ? "entities" : "company",
      sftp_path: hasEntities ? "" : companyPath,
      file_path: hasEntities ? "" : companyPath,
      status: row.status || "Pending",
      entities: hasEntities
        ? groupedRows.map((item, index) => ({
          id: item.id || `entity-${index + 1}`,
          entity_code: item.entity_code || "",
          sftp_path: item.sftp_path || item.file_path || "",
          file_path: item.sftp_path || item.file_path || "",
          status: item.status || "Pending"
        }))
        : [createEmptyEntityRow()]
    }));
    setClientConfigStatus("Company selected for editing.");
  };

  // Reset form state after successful writes or when the operator cancels editing.
  const clearClientConfigForm = () => {
    setClientConfigForm(normalizeClientConfigForm(emptyClientConfigForm));
    setClientConfigStatus("");
  };

  // Client configuration writes go through backend CRUD endpoints so the database
  // remains the single source of truth.
  const addClientConfig = async () => {
    const normalizedForm = normalizeClientConfigForm(clientConfigForm);
    setClientConfigForm(normalizedForm);

    const validationMessage = validateClientConfigForm(normalizedForm);
    if (validationMessage) {
      setClientConfigStatus(validationMessage);
      return;
    }

    await withSpinner("Adding company...", async () => {
      try {
        const res = await fetch("/client-config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildClientConfigPayload(normalizedForm))
        });
        if (!res.ok) {
          const error = await readBackendError(res, "Could not add company.");
          setClientConfigStatus(error.message);
          return;
        }
        clearClientConfigForm();
        await refreshClientConfig("Company added.");
      } catch {
        setClientConfigStatus("Could not add company.");
      }
    });
  };

  const updateClientConfig = async () => {
    const normalizedForm = normalizeClientConfigForm(clientConfigForm);
    setClientConfigForm(normalizedForm);

    const validationMessage = validateClientConfigForm(normalizedForm, true);
    if (validationMessage) {
      setClientConfigStatus(validationMessage);
      return;
    }

    await withSpinner("Updating company...", async () => {
      try {
        const companyKey = encodeURIComponent(normalizedForm.client_group_key || normalizedForm.client_id);
        const res = await fetch(`/client-config/${companyKey}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildClientConfigPayload(normalizedForm))
        });
        if (!res.ok) {
          const error = await readBackendError(res, "Could not update company.");
          setClientConfigStatus(error.message);
          return;
        }
        await refreshClientConfig("Company updated.");
      } catch {
        setClientConfigStatus("Could not update company.");
      }
    });
  };

  const deleteClientConfig = async () => {
    if (!clientConfigForm.client_group_key && !clientConfigForm.client_id) {
      setClientConfigStatus("Select a company row to delete.");
      return;
    }
    if (!window.confirm("Delete this company and all related entity rows?")) return;
    await withSpinner("Deleting company...", async () => {
      try {
        const companyKey = encodeURIComponent(clientConfigForm.client_group_key || clientConfigForm.client_id);
        const res = await fetch(`/client-config/${companyKey}`, { method: "DELETE" });
        if (!res.ok) throw new Error("Delete failed");
        clearClientConfigForm();
        await refreshClientConfig("Company deleted.");
      } catch {
        setClientConfigStatus("Could not delete company.");
      }
    });
  };


  const updateManagedUser = (role, field, value) => {
    setAuthUsers((current) => ({
      ...current,
      [role]: {
        ...current[role],
        [field]: value
      }
    }));
    setUsersStatus("");
  };

  const saveManagedUsers = () => {
    const adminUsername = cleanInputText(authUsers.admin?.username).toLowerCase();
    const userUsername = cleanInputText(authUsers.user?.username).toLowerCase();
    const adminPassword = String(authUsers.admin?.password || "").trim();
    const userPassword = String(authUsers.user?.password || "").trim();

    if (!adminUsername || !userUsername) {
      setUsersStatus("Admin and User username are required.");
      return;
    }

    if (!adminPassword || !userPassword) {
      setUsersStatus("Admin and User password are required.");
      return;
    }

    const nextUsers = {
      admin: { username: adminUsername, password: adminPassword },
      user: { username: userUsername, password: userPassword }
    };

    saveAuthUsers(nextUsers);
    setUsersStatus("Users updated successfully.");

    if (authUser?.role && nextUsers[authUser.role]) {
      const nextSession = { ...authUser, username: nextUsers[authUser.role].username };
      setAuthUser(nextSession);
      window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(nextSession));
    }
  };

  if (!isLoggedIn) {
    return <LoginPage onLogin={login} />;
  }

  return (
    <div className="min-h-screen bg-slate-100">
      {networkWarning && <NetworkToast onClose={() => setNetworkWarning(false)} />}
      {networkConnected && <NetworkConnectedToast />}
      {showLoadingSpinner && <LoadingOverlay message={loadingMessage} />}

      <aside className={`fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-blue-900 bg-blue-950 px-3.5 py-4 text-blue-100 transition-transform ${isNavOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="mb-5 flex items-center gap-2.5 border-b border-blue-800 pb-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100 text-[#001f3f]">
            <Icon name="spreadsheet" />
          </div>
          <div>
            <h1 className="m-0 text-base font-semibold text-white">Paysheet</h1>
            <p className="m-0 text-xs text-blue-100">Automation Console</p>
          </div>
        </div>
        <nav className="space-y-2">
          {visibleTabs.map((tab) => (
            <button key={tab.id} className={`flex w-full items-center gap-2 rounded-md border px-3 py-2.5 text-left text-sm font-semibold ${activeTab === tab.id ? "border-blue-100 bg-white text-[#001f3f]" : "border-transparent text-blue-100 hover:bg-blue-900"}`} onClick={() => selectTab(tab.id)}>
              <Icon name={tab.icon} />
              {tab.label}
            </button>
          ))}
        </nav>
        <div className="mt-auto border-t border-blue-800 px-2 pt-3 text-center text-xs text-blue-200">
          © 2026 Vista Team
        </div>
      </aside>
      {isNavOpen && <div className="fixed inset-0 z-30 bg-blue-950/25" aria-hidden="true" onClick={() => setIsNavOpen(false)} />}

      <main className="min-w-0">
        <header className="sticky top-0 z-20 border-b border-[#00152b] bg-[#001f3f] px-5 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <button className="btn btn-outline-light h-10 w-10 px-0" type="button" onClick={() => setIsNavOpen(true)} aria-label="Open navigation">
                <Icon name="menu" />
              </button>
              <div className="min-w-0">
                <h2 className="m-0 truncate text-lg font-semibold text-white">Operations Dashboard</h2>
                <p className="m-0 hidden text-sm text-blue-100 2xl:block">Track download and upload pipeline in real time</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 overflow-x-auto pb-1">
              {showDashboardSummary && (
                <div className="flex shrink-0 items-center gap-2">
                  <div className="inline-flex items-center gap-2 rounded-md border border-white/20 bg-white/10 px-3 py-2 text-sm text-white whitespace-nowrap">
                    <span className="text-blue-100">Period</span>
                    <span className="font-semibold uppercase tracking-wide">{selectedMonthYear}</span>
                  </div>
                  <button className="btn btn-success whitespace-nowrap px-4" type="button" disabled={isAutomationRunning && !isAutomationPaused} onClick={() => isAutomationPaused ? resumeAutomation() : setIsStartConfirmOpen(true)}>
                    <Icon name="play" />{isAutomationPaused ? "Resume" : isAutomationRunning ? "Running" : "Start"}
                  </button>
                  <button className="btn btn-warning whitespace-nowrap px-4" type="button" disabled={!isAutomationRunning || isAutomationPaused} onClick={pauseAutomation}>
                    <Icon name="pause" />Pause
                  </button>
                  <button className="btn btn-danger whitespace-nowrap px-4" type="button" disabled={!isAutomationRunning} onClick={() => setIsStopConfirmOpen(true)}>
                    <Icon name="stop" />Stop
                  </button>
                </div>
              )}
              <div className="flex shrink-0 items-center gap-2 rounded-md border border-white/20 bg-white/10 px-3 py-2 text-sm text-white whitespace-nowrap">
                <span className="max-w-32 truncate">{authUser.username}</span>
                <span className="rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-semibold uppercase">{isAdmin ? "Admin" : "User"}</span>
                <button className="text-xs font-semibold text-blue-100 underline-offset-4 hover:underline" type="button" onClick={logout}>
                  Sign out
                </button>
              </div>
            </div>
          </div>
        </header>

        <div className={`grid gap-4 p-5 ${activeTab === "live" ? "lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start" : "lg:grid-cols-1"}`}>
          <div className="min-w-0 space-y-4">
          {showDashboardSummary && <section className="panel grid gap-4 px-4 py-3 md:grid-cols-[minmax(360px,auto)_minmax(300px,1fr)] md:items-center">
            <RunStepper activeStep={activeRunStep} isRunning={isAutomationRunning} isFinished={runFinished} />
            <div className="w-full md:max-w-2xl md:justify-self-end">
              <div className="mb-1 flex items-center justify-between gap-3 text-xs font-semibold text-slate-500">
                <span className="inline-flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-[#001f3f]" />
                  Progress
                </span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">{stats.completed}/{stats.total} completed</span>
              </div>
              <div className="h-3 overflow-hidden rounded-full bg-slate-200">
                <div className="h-full rounded-full bg-blue-600 text-center text-[10px] font-semibold leading-3 text-white transition-all" style={{ width: `${progressPercent}%` }}>
                  {progressPercent}%
                </div>
              </div>
              <div className="mt-1 flex items-center justify-between gap-3 text-xs text-slate-500">
                <span>Current company: {currentClient}</span>
                <span>{isAutomationPaused ? "Paused" : stats.processing > 0 ? "Running" : "To start the automation"}</span>
              </div>
            </div>
          </section>}

          {showDashboardSummary && <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Metric label="Total" value={stats.total} icon="list" tone="border-[#001f3f]" />
            <Metric label="Processing" value={stats.processing} icon="hourglass" tone="border-amber-500" />
            <Metric label="Success" value={stats.success} icon="check" tone="border-emerald-500" />
            <Metric label="Failed" value={stats.failed} icon="warning" tone="border-red-500" />
          </section>}

          {showDashboardSummary && <section className={`grid gap-3 ${activeTab === "live" ? "md:grid-cols-[auto_minmax(320px,520px)]" : "md:grid-cols-1"} md:items-center md:justify-between`}>
            <div className="flex flex-wrap gap-2">
              {visibleToolbarTabs.map((tab) => (
                <button key={tab.id} className={`btn btn-sm ${activeTab === tab.id ? "btn-primary" : "btn-outline-primary"}`} type="button" onClick={() => selectTab(tab.id)}>
                  <Icon name={tab.icon} />{tab.label}
                </button>
              ))}
            </div>
            {activeTab === "live" && <div className="w-full">
              <label className="relative block flex-1">
                <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input className="field pl-9" value={liveSearch} onChange={(event) => setLiveSearch(event.target.value)} placeholder="Search live run by company, entity, period, or status" />
              </label>
            </div>}
          </section>}

          {activeTab === "live" && (
            <LiveTab
              rows={filteredLiveRows}
              liveFilter={liveFilter}
              setLiveFilter={setLiveFilter}
              onSelect={showRecordDetails}
              isAutomationRunning={isAutomationRunning}
              currentClient={currentClient}
            />
          )}
          {activeTab === "history" && (
            <HistoryTab
              rows={historyRows}
              months={historyMonths}
              years={years}
              companyOptions={historyCompanyOptions}
              month={historyMonth}
              year={historyYear}
              company={historyCompany}
              setMonth={setHistoryMonth}
              setYear={setHistoryYear}
              setCompany={setHistoryCompany}
              onShowAll={showAllHistory}
            />
          )}
          {activeTab === "sftp" && <SftpTab onOpen={openSftpPortal} />}
          {activeTab === "clients" && (
            <ClientsTab
              rows={filteredCompanyRows}
              search={companiesSearch}
              setSearch={setCompaniesSearch}
              refreshCompanies={loadDbData}
            />
          )}
          {activeTab === "stopProcess" && (
            <StopProcessTab
              companies={stopProcessCompanies}
              stopRows={stopProcessRecords}
              form={stopProcessForm}
              setForm={setStopProcessForm}
              entityOptions={stopProcessEntityOptions}
              status={stopProcessStatus}
              onAdd={addStopProcess}
              onRemove={removeStopProcess}
            />
          )}
          {activeTab === "users" && (
            <UsersTab
              authUsers={authUsers}
              status={usersStatus}
              onChange={updateManagedUser}
              onSave={saveManagedUsers}
            />
          )}
          {activeTab === "config" && (
            <ConfigHub
              activeSection={configSection}
              setActiveSection={setConfigSection}
              clientConfigProps={{
                rows: filteredClientConfigRows,
                search: clientConfigSearch,
                setSearch: setClientConfigSearch,
                form: clientConfigForm,
                setForm: setClientConfigForm,
                status: clientConfigStatus,
                onSelect: selectClientConfigRow,
                onAdd: addClientConfig,
                onUpdate: updateClientConfig,
                onDelete: deleteClientConfig,
                onClear: clearClientConfigForm,
                onUploadOpen: () => setIsUploadOpen(true)
              }}
              dbProps={{
                sqlQuery,
                setSqlQuery,
                rows: dbResultRows,
                columns: dbResultColumns,
                onExecute: executeSql,
                onStop: stopSql,
                onListTables: listTables,
                onRestoreCompleted: async () => {
                  resetDashboard();
                  const rows = await loadDbData(true);
                  hydrateLiveFromDb(rows);
                  await loadHistoryData(true);
                }
              }}
              settingsProps={{
                config,
                setConfig,
                status: configStatus,
                setStatus: setConfigStatus,
                withSpinner
              }}
              logs={logs}
              selectedMonthYear={selectedMonthYear}
              setSelectedMonthYear={selectRunMonth}
            />
          )}
          </div>
          {activeTab === "live" && (
            <RightStatusPanel
              logs={logs}
              notifications={notifications}
              selectedRecord={selectedRecord}
              isAutomationRunning={isAutomationRunning}
              isAutomationPaused={isAutomationPaused}
            />
          )}
        </div>
      </main>

      {isUploadOpen && (
        <Modal title="Upload Company File" onClose={() => setIsUploadOpen(false)}>
          <p className="mb-3 text-sm text-slate-500">Use Excel or CSV with Company ID, Company Name, Entity Code, and SFTP Path.</p>
          <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-blue-200 bg-blue-50/60 px-4 py-6 text-center transition hover:border-blue-400 hover:bg-blue-50">
            <input className="sr-only" type="file" ref={fileInputRef} accept=".xlsx,.xls,.csv" />
            <span className="mb-2 flex h-11 w-11 items-center justify-center rounded-full bg-blue-600 text-white">
              <Icon name="upload" className="h-5 w-5" />
            </span>
            <span className="text-sm font-semibold text-slate-800">Choose Excel or CSV file</span>
            <span className="mt-1 text-xs text-slate-500">Supported formats: .xlsx, .xls, .csv</span>
          </label>
          <div className="mt-4 flex justify-between gap-2">
            <button className="btn btn-primary" onClick={uploadFile}><Icon name="upload" />Upload</button>
            <button className="btn btn-outline-secondary" onClick={() => setIsUploadOpen(false)}>Cancel</button>
          </div>
          {uploadError && <p className="mt-2 text-sm text-red-600">{uploadError}</p>}
        </Modal>
      )}

      {uploadFeedback && (
        <Modal title={uploadFeedback.title} onClose={() => setUploadFeedback(null)}>
          <div className="flex flex-col items-center text-center">
            <span className={`mb-4 flex h-16 w-16 items-center justify-center rounded-full ${uploadFeedback.type === "success" ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-600"}`}>
              <Icon name={uploadFeedback.type === "success" ? "check" : "x"} className="h-8 w-8" />
            </span>
            <p className="text-sm text-slate-600">{uploadFeedback.message}</p>
            {uploadFeedback.items?.length > 0 && (
              <div className="mt-4 max-h-40 w-full overflow-auto rounded-md border border-red-100 bg-red-50 p-3 text-left text-sm text-red-700">
                {uploadFeedback.items.map((item) => (
                  <div key={item}>{item}</div>
                ))}
              </div>
            )}
            <button className="btn btn-primary mt-5" type="button" onClick={() => setUploadFeedback(null)}>OK</button>
          </div>
        </Modal>
      )}

      {backendAlert && (
        <Modal title={backendAlert.title} onClose={() => setBackendAlert(null)}>
          <div className="flex flex-col items-center text-center">
            <span className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-50 text-red-600">
              <Icon name="warning" className="h-8 w-8" />
            </span>
            <p className="text-sm text-slate-600">{backendAlert.message}</p>
            {backendAlert.supportMessage && (
              <p className="mt-3 rounded-md border border-red-100 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
                {backendAlert.supportMessage}
              </p>
            )}
            {backendAlert.items?.length > 0 && (
              <div className="mt-4 max-h-40 w-full overflow-auto rounded-md border border-red-100 bg-red-50 p-3 text-left text-sm text-red-700">
                {backendAlert.items.map((item) => (
                  <div key={item}>{item}</div>
                ))}
              </div>
            )}
            <button className="btn btn-primary mt-5" type="button" onClick={() => setBackendAlert(null)}>OK</button>
          </div>
        </Modal>
      )}

      {isStartConfirmOpen && (
        <Modal title="Start Automation" onClose={() => setIsStartConfirmOpen(false)}>
          <p className="mb-4 text-sm text-slate-500">Do you want to start the automation?</p>
          <div className="flex justify-between gap-2">
            <button className="btn btn-outline-secondary" type="button" onClick={() => setIsStartConfirmOpen(false)}>Cancel</button>
            <button className="btn btn-success" type="button" disabled={isAutomationRunning} onClick={startAutomation}>
              <Icon name="play" />Confirm
            </button>
          </div>
        </Modal>
      )}

      {isStopConfirmOpen && (
        <Modal title="Stop Automation" onClose={() => setIsStopConfirmOpen(false)}>
          <p className="mb-4 text-sm text-slate-500">Are you sure you want to stop the automation?</p>
          <div className="flex justify-between gap-2">
            <button className="btn btn-outline-secondary" type="button" onClick={() => setIsStopConfirmOpen(false)}>Cancel</button>
            <button className="btn btn-danger" type="button" onClick={stopAutomation}>
              <Icon name="stop" />Confirm
            </button>
          </div>
        </Modal>
      )}

      {isConfigAuthOpen && (
        <Modal title="Config Access Required" onClose={() => setIsConfigAuthOpen(false)}>
          <p className="mb-3 text-sm text-slate-500">Enter username and password to open Config.</p>
          <div className="space-y-2">
            <input className="field" value={configAuth.user} onChange={(event) => setConfigAuth((value) => ({ ...value, user: event.target.value }))} placeholder="Username" />
            <input className="field" type="password" value={configAuth.pass} onChange={(event) => setConfigAuth((value) => ({ ...value, pass: event.target.value }))} placeholder="Password" />
          </div>
          <div className="mt-4 flex justify-between gap-2">
            <button className="btn btn-primary" type="button" onClick={openConfigAfterAuth}>Login</button>
            <button className="btn btn-outline-secondary" type="button" onClick={() => setIsConfigAuthOpen(false)}>Cancel</button>
          </div>
          {configAuthError && <p className="mt-2 text-sm text-red-600">{configAuthError}</p>}
        </Modal>
      )}

      <div className="hidden">{logs.map((line) => <div key={line}>{line}</div>)}</div>
    </div>
  );
}

function LoginPage({ onLogin }) {
  const [mode, setMode] = useState("user");
  const [view, setView] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [resetEmail, setResetEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [resetMessage, setResetMessage] = useState("");

  const isAdminMode = mode === "admin";
  const roleLabel = isAdminMode ? "admin" : "user";

  const submit = (event) => {
    event.preventDefault();
    const cleanEmail = cleanInputText(email).toLowerCase();
    const expected = readAuthUsers()[roleLabel];
    if (!cleanEmail || !password.trim()) {
      setError("Enter username and password.");
      return;
    }
    if (cleanEmail !== String(expected.username || "").toLowerCase() || password !== expected.password) {
      setError("Invalid username or password.");
      return;
    }
    setError("");
    onLogin({ username: expected.username, role: roleLabel });
  };

  const submitPasswordReset = (event) => {
    event.preventDefault();
    const cleanEmail = cleanInputText(resetEmail).toLowerCase();
    const expected = readAuthUsers()[roleLabel];
    if (!cleanEmail || !newPassword.trim() || !confirmPassword.trim()) {
      setError("Username, new password, and confirm password are required.");
      return;
    }
    if (cleanEmail !== String(expected.username || "").toLowerCase()) {
      setError(`Username does not match the ${roleLabel} account.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New password and confirm password must match.");
      return;
    }
    const currentUsers = readAuthUsers();
    const nextUsers = {
      ...currentUsers,
      [roleLabel]: {
        ...expected,
        password: newPassword
      }
    };
    saveAuthUsers(nextUsers);
    setError("");
    setEmail(expected.username);
    setPassword(newPassword);
    setResetMessage("Password reset completed. Sign in with the new password.");
    setView("signin");
  };

  const switchMode = () => {
    setMode((value) => (value === "admin" ? "user" : "admin"));
    setError("");
    setResetMessage("");
    setView("signin");
  };

  const openForgotPassword = () => {
    setView("forgot");
    setError("");
    setResetMessage("");
    setResetEmail(email);
    setNewPassword("");
    setConfirmPassword("");
  };

  const backToSignIn = () => {
    setView("signin");
    setError("");
  };

  return (
    <main className="min-h-screen bg-[#eef4fb]">
      <header className="fixed inset-x-0 top-0 z-20 border-b border-[#00152b] bg-[#001f3f] px-6 py-4 shadow-sm">
        <div className="mx-auto flex max-w-6xl items-center gap-3 text-white">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-white text-[#001f3f]">
            <Icon name="spreadsheet" className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-lg font-semibold">Paysheet Automation</h1>
            <p className="text-xs text-blue-100">Control downloads, uploads, logs, and company status from one console.</p>
          </div>
        </div>
      </header>

      <div className="flex min-h-screen items-center justify-center px-4 pb-10 pt-28">
        <section className="w-full max-w-md overflow-hidden rounded-xl border border-[#dbe5f0] bg-white shadow-xl">
          <form className="p-8 sm:p-10" onSubmit={view === "forgot" ? submitPasswordReset : submit}>
            <div className="mb-7 text-center">
              <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-[#001f3f] text-white">
                <Icon name="spreadsheet" className="h-6 w-6" />
              </span>
              <p className="text-xs font-semibold uppercase tracking-wide text-blue-600">{view === "forgot" ? "Password Help" : isAdminMode ? "Admin Access" : "User Access"}</p>
              <h2 className="mt-1 text-2xl font-semibold text-slate-900">{view === "forgot" ? "Reset Password" : "Sign In"}</h2>
              <p className="mt-1 text-sm text-slate-500">{view === "forgot" ? "Enter the registered username and set a new password." : "Enter your credentials to continue."}</p>
            </div>

            {view === "forgot" ? (
              <div className="space-y-4">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-slate-600">Username</span>
                  <input
                    className="field"
                    type="text"
                    value={resetEmail}
                    onChange={(event) => setResetEmail(event.target.value)}
                    placeholder={readAuthUsers()[roleLabel].username}
                    autoComplete="username"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-slate-600">New Password</span>
                  <input
                    className="field"
                    type="password"
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    placeholder="Enter new password"
                    autoComplete="new-password"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-slate-600">Confirm Password</span>
                  <input
                    className="field"
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    placeholder="Confirm new password"
                    autoComplete="new-password"
                  />
                </label>
              </div>
            ) : (
              <>
                <div className="space-y-4">
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium text-slate-600">Username</span>
                    <input
                      className="field"
                      type="text"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder={readAuthUsers()[roleLabel].username}
                      autoComplete="username"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium text-slate-600">Password</span>
                    <input
                      className="field"
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="Enter password"
                      autoComplete={isAdminMode ? "current-password" : "password"}
                    />
                  </label>
                </div>

                <div className="mt-4 flex items-center justify-between text-xs text-slate-500">
                  <label className="inline-flex items-center gap-2">
                    <input className="h-4 w-4 rounded border-slate-300 text-[#001f3f]" type="checkbox" checked readOnly />
                    Keep me signed in
                  </label>
                  <button className="font-semibold text-[#001f3f] underline-offset-4 hover:underline" type="button" onClick={openForgotPassword}>
                    Forgot password?
                  </button>
                </div>
              </>
            )}

            {error && <p className="mt-3 rounded-md border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            {resetMessage && <p className="mt-3 rounded-md border border-emerald-100 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{resetMessage}</p>}

            <button className="btn btn-primary mt-5 w-full" type="submit">
              <Icon name={view === "forgot" ? "save" : isAdminMode ? "settings" : "users"} />
              {view === "forgot" ? "Update Password" : "Sign In"}
            </button>

            <div className="mt-5 text-center text-sm text-slate-500">
              {view === "forgot" ? (
                <button className="font-semibold text-[#001f3f] underline-offset-4 hover:underline" type="button" onClick={backToSignIn}>
                  Back to sign in
                </button>
              ) : (
                <button className="font-semibold text-[#001f3f] underline-offset-4 hover:underline" type="button" onClick={switchMode}>
                  {isAdminMode ? "User login" : "Admin login"}
                </button>
              )}
            </div>
          </form>
        </section>
      </div>
    </main>
  );
}

function Phase({ active = false, title, text }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`h-2.5 w-2.5 rounded-full ${active ? "bg-[#001f3f]" : "bg-blue-200"}`} />
      <div>
        <strong className={`block text-sm ${active ? "text-[#001f3f]" : "text-slate-600"}`}>{title}</strong>
        <p className={`m-0 text-xs ${active ? "text-[#001f3f]" : "text-slate-500"}`}>{text}</p>
      </div>
    </div>
  );
}

function StepBadge({ number, active, complete }) {
  if (complete) {
    return (
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-600 text-white">
        <Icon name="check" className="h-4 w-4" />
      </span>
    );
  }

  return (
    <span className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${active ? "stepper-blink-slow bg-[#001f3f] text-white" : "bg-[#e8f0fb] text-[#001f3f]"}`}>
      {number}
    </span>
  );
}

function RunStepper({ activeStep, isRunning, isFinished }) {
  const downloadComplete = isFinished || activeStep > 1;
  const uploadComplete = isFinished;
  const downloadActive = isRunning && activeStep === 1 && !downloadComplete;
  const uploadActive = isRunning && activeStep === 2 && !uploadComplete;

  return (
    <div className="flex min-w-0 items-center">
      <div className="flex items-center gap-3">
        <StepBadge number="1" active={downloadActive} complete={downloadComplete} />
        <strong className="block text-sm text-[#001f3f]">Download</strong>
      </div>
      <div className={`mx-4 h-px w-14 md:w-20 ${downloadComplete ? "bg-emerald-300" : "bg-blue-200"}`} />
      <div className="flex items-center gap-3">
        <StepBadge number="2" active={uploadActive} complete={uploadComplete} />
        <strong className={`block text-sm ${uploadActive || uploadComplete ? "text-[#001f3f]" : "text-slate-700"}`}>Upload</strong>
      </div>
    </div>
  );
}

function NetworkToast({ onClose }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/35 px-4 backdrop-blur-sm" role="alert" aria-modal="true">
      <div className="w-full max-w-sm rounded-lg border border-red-200 bg-white p-6 text-center shadow-2xl">
        <span className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-50 text-red-600">
          <Icon name="warning" className="h-8 w-8" />
        </span>
        <h3 className="text-lg font-semibold text-slate-900">Network warning</h3>
        <p className="mt-2 text-sm text-slate-600">Connect to network.</p>
        <button className="btn btn-danger mt-5" type="button" onClick={onClose}>
          OK
        </button>
      </div>
    </div>
  );
}

function NetworkConnectedToast() {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/20 px-4 backdrop-blur-sm" role="status">
      <div className="w-full max-w-sm rounded-lg border border-emerald-200 bg-white p-6 text-center shadow-2xl">
        <span className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
          <Icon name="check" className="h-8 w-8" />
        </span>
        <h3 className="text-lg font-semibold text-slate-900">Network connected</h3>
        <p className="mt-2 text-sm text-slate-600">Connection is available now.</p>
      </div>
    </div>
  );
}

function LoadingOverlay({ message }) {
  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-slate-950/20 px-4 backdrop-blur-[2px]" role="status" aria-live="polite">
      <div className="flex min-w-64 flex-col items-center rounded-lg border border-blue-100 bg-white px-7 py-6 text-center shadow-2xl">
        <span className="mb-4 h-11 w-11 animate-spin rounded-full border-4 border-blue-100 border-t-[#001f3f]" aria-hidden="true" />
        <p className="text-sm font-semibold text-[#001f3f]">{message || "Loading..."}</p>
        <p className="mt-1 text-xs text-slate-500">Please wait while the data is prepared.</p>
      </div>
    </div>
  );
}

// Compact dashboard metric tile.
function Metric({ label, value, icon, tone }) {
  return (
    <div className={`panel min-h-[76px] border-l-4 ${tone} px-4 py-3`}>
      <div className="flex items-center justify-between gap-3 text-sm font-medium text-slate-500">
        <span>{label}</span>
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-slate-100 text-slate-600">
          <Icon name={icon} className="h-4 w-4" />
        </span>
      </div>
      <div className="mt-1.5 text-xl font-semibold leading-none text-slate-900">{value}</div>
    </div>
  );
}

// Status label used by Live Run and client tables.
function StatusChip({ status }) {
  const normalized = String(status || "PENDING").toUpperCase();
  const map = {
    SUCCESS: { label: "Success", className: "status-success", icon: "check" },
    FAILED: { label: "Failed", className: "status-failed", icon: "x" },
    PROCESSING: { label: "Processing", className: "status-processing", icon: "hourglass" },
    PENDING: { label: "Pending", className: "status-pending", icon: "circle" }
  };
  const meta = map[normalized] || { label: normalized, className: "status-muted", icon: "circle" };
  return <span className={`status-chip ${meta.className}`}><Icon name={meta.icon} className="h-3.5 w-3.5" />{meta.label}</span>;
}

function ClientStatusBadge({ status }) {
  const normalized = String(status || "ACTIVE").toUpperCase();
  const meta = normalized === "STOPPED"
    ? { label: "Stopped", className: "bg-red-100 text-red-700", icon: "pause" }
    : { label: "Active", className: "bg-emerald-100 text-emerald-700", icon: "check" };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold ${meta.className}`}>
      <Icon name={meta.icon} className="h-3.5 w-3.5" />{meta.label}
    </span>
  );
}

// Month selector used by toolbar actions and log export.
function MonthDropdown({ value, onChange, isOpen, setIsOpen }) {
  return (
    <div className="relative w-40">
      <button
        className="inline-flex w-full items-center justify-between gap-3 rounded-md border border-white/60 bg-white px-4 py-2 text-sm font-semibold uppercase text-[#001f3f] shadow-sm transition hover:bg-blue-50"
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span>{value}</span>
        <span className={`text-xs transition-transform ${isOpen ? "rotate-180" : ""}`}>⌄</span>
      </button>
      {isOpen && (
        <div className="absolute left-0 z-50 mt-2 w-full overflow-hidden rounded-md border border-slate-200 bg-white shadow-xl" role="listbox">
          {getMonthYearOptions().map((option) => (
            <button
              key={option.value}
              className={`block w-full px-4 py-2.5 text-left text-sm font-semibold uppercase transition ${option.value === value ? "bg-[#001f3f] text-white" : "text-[#001f3f] hover:bg-blue-50"}`}
              type="button"
              onClick={() => {
                onChange(option.value);
                setIsOpen(false);
              }}
              role="option"
              aria-selected={option.value === value}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const getRowFailed = (row) => {
  const hris = String(row.hrisStatus || row.downloadStatus || "").toUpperCase();
  const paysheet = String(row.paysheetStatus || row.downloadStatus || "").toUpperCase();
  const upload = String(row.uploadStatus || "").toUpperCase();
  return hris === "FAILED" || paysheet === "FAILED" || upload === "FAILED";
};

const getRowProcessing = (row) => {
  const hris = String(row.hrisStatus || row.downloadStatus || "").toUpperCase();
  const paysheet = String(row.paysheetStatus || row.downloadStatus || "").toUpperCase();
  const upload = String(row.uploadStatus || "").toUpperCase();
  return hris === "PROCESSING" || paysheet === "PROCESSING" || upload === "PROCESSING";
};

const getRowCompleted = (row) => {
  const hris = String(row.hrisStatus || row.downloadStatus || "").toUpperCase();
  const paysheet = String(row.paysheetStatus || row.downloadStatus || "").toUpperCase();
  const upload = String(row.uploadStatus || "").toUpperCase();
  return hris === "SUCCESS" && paysheet === "SUCCESS" && upload === "SUCCESS";
};

const getLiveGroupStatus = (items) => {
  if (!items.length) return "Pending";
  if (items.some(getRowProcessing)) return "Processing";
  if (items.some(getRowFailed)) return items.every(getRowFailed) ? "Failed" : "Partially Failed";
  if (items.every(getRowCompleted)) return "Completed";
  if (items.some(getRowCompleted)) return "In Progress";
  return "Pending";
};

const getStatusSummary = (values) => {
  const normalized = values
    .map((value) => String(value || "PENDING").toUpperCase())
    .filter(Boolean);
  if (!normalized.length) return "PENDING";
  if (normalized.every((value) => value === "SUCCESS")) return "SUCCESS";
  if (normalized.some((value) => value === "PROCESSING")) return "PROCESSING";
  if (normalized.every((value) => value === "FAILED")) return "FAILED";
  if (normalized.some((value) => value === "FAILED")) return "PARTIAL";
  if (normalized.some((value) => value === "SUCCESS")) return "PROCESSING";
  return "PENDING";
};

const getSharedPathLabel = (items) => {
  const uniquePaths = Array.from(
    new Set(
      items
        .map((item) => String(item.sftpPath || item.filePath || "").trim())
        .filter(Boolean)
    )
  );
  if (!uniquePaths.length) return "-";
  if (uniquePaths.length === 1) return uniquePaths[0];
  return "Multiple Paths";
};

const makeLiveGroups = (rows) => {
  const map = new Map();
  rows.forEach((row) => {
    const companyCode = row.clientCode || row.client_id || row.client_code || "-";
    const key = String(companyCode || "-").toUpperCase();
    if (!map.has(key)) {
      map.set(key, {
        key,
        companyCode,
        companyName: row.clientName || row.client_name || companyCode,
        month: row.month || "-",
        items: []
      });
    }
    const group = map.get(key);
    group.items.push(row);
    if (!group.companyName || group.companyName === group.companyCode) group.companyName = row.clientName || row.client_name || group.companyName;
    if (!group.month || group.month === "-") group.month = row.month || group.month;
  });

  return Array.from(map.values()).map((group) => {
    const entityItems = group.items.filter((item) => {
      const code = String(item.entityCode || item.entity_code || "").trim();
      return code && !(group.items.length === 1 && isNoEntityDefaultCode(code));
    });
    const completed = group.items.filter(getRowCompleted).length;
    const failed = group.items.filter(getRowFailed).length;
    const processing = group.items.filter(getRowProcessing).length;
    return {
      ...group,
      hasEntities: entityItems.length > 0,
      entityCount: entityItems.length,
      totalCount: group.items.length,
      completed,
      failed,
      processing,
      status: getLiveGroupStatus(group.items)
    };
  });
};

function LiveEntityRow({ item, onSelect, activeRowKey }) {
  const hrisStatus = item.hrisStatus || item.downloadStatus;
  const paysheetStatus = item.paysheetStatus || item.downloadStatus;
  const rowKey = item.rowKey || getClientRowKey(item.clientCode, item.entityCode, item.month);
  const isActive = activeRowKey && rowKey === activeRowKey;
  const sftpPath = item.sftpPath || item.filePath || "-";

  return (
    <div
      className={`grid cursor-pointer grid-cols-[13%_20%_10%_11%_14%_14%_18%] items-center border-t border-slate-100 px-3 py-3 text-sm text-slate-700 transition-colors ${isActive ? "bg-blue-50/70" : "hover:bg-slate-50/80"}`}
      onClick={() => onSelect(item, "live")}
    >
      <div className="truncate px-1 text-center">{item.clientCode || "-"}</div>
      <div className="truncate px-1 text-center">{item.clientName || item.clientCode || "-"}</div>
      <div className="truncate px-1 text-center">{item.entityCode || "001"}</div>
      <div className="truncate px-1 text-center">{item.month || "-"}</div>
      <div className="flex justify-center px-1"><StatusChip status={hrisStatus} /></div>
      <div className="flex justify-center px-1"><StatusChip status={paysheetStatus} /></div>
      <div className="truncate px-1 text-center" title={sftpPath}>{sftpPath}</div>
    </div>
  );
}

function LiveCompanyGroup({ group, isExpanded, onToggle, onSelect, activeRowKey }) {
  const firstItem = group.items[0] || {};
  const canExpand = group.hasEntities && group.items.length > 1;
  const hrisSummary = getStatusSummary(group.items.map((item) => item.hrisStatus || item.downloadStatus));
  const paysheetSummary = getStatusSummary(group.items.map((item) => item.paysheetStatus || item.downloadStatus));
  const pathLabel = getSharedPathLabel(group.items);

  if (!canExpand) {
    return <LiveEntityRow item={firstItem} onSelect={onSelect} activeRowKey={activeRowKey} />;
  }

  return (
    <div className="border-t border-slate-100">
      <button
        type="button"
        className="grid w-full grid-cols-[13%_20%_10%_11%_14%_14%_18%] items-center px-3 py-3 text-left text-sm text-slate-700 hover:bg-[#f7faff]"
        onClick={onToggle}
      >
        <div className="flex items-center justify-center gap-3 px-1 font-semibold text-[#001f3f]">
          <span className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-xs">{isExpanded ? "▲" : "▼"}</span>
          <span className="truncate text-center">{group.companyCode}</span>
        </div>
        <div className="truncate px-1 text-center font-medium">{group.companyName || group.companyCode}</div>
        <div className="px-1 text-center"><span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">{group.entityCount} Entities</span></div>
        <div className="truncate px-1 text-center">{group.month}</div>
        <div className="flex justify-center px-1"><StatusChip status={hrisSummary} /></div>
        <div className="flex justify-center px-1"><StatusChip status={paysheetSummary} /></div>
        <div className="truncate px-1 text-center" title={pathLabel}>{pathLabel}</div>
      </button>
      {isExpanded && (
        <div className="bg-slate-50/70">
          <div className="grid grid-cols-[13%_20%_10%_11%_14%_14%_18%] px-3 py-2 text-[11px] font-semibold uppercase text-slate-500">
            <div className="px-1 text-center">Company Code</div>
            <div className="px-1 text-center">Company Name</div>
            <div className="px-1 text-center">Entity</div>
            <div className="px-1 text-center">Period</div>
            <div className="px-1 text-center">HRIS Status</div>
            <div className="px-1 text-center">Paysheet Status</div>
            <div className="px-1 text-center">SFTP Path</div>
          </div>
          {group.items.map((item, index) => (
            <LiveEntityRow key={item.rowKey || getClientRowKey(item.clientCode, item.entityCode || index, item.month)} item={item} onSelect={onSelect} activeRowKey={activeRowKey} />
          ))}
        </div>
      )}
    </div>
  );
}

// Primary live automation view with filters and automatic active-row scrolling.
function LiveTab({ rows, liveFilter, setLiveFilter, onSelect, isAutomationRunning, currentClient }) {
  const [expandedGroups, setExpandedGroups] = useState({});
  const [viewportHeight, setViewportHeight] = useState(() => {
    if (typeof window === "undefined") return 720;
    return window.innerHeight || 720;
  });

  useEffect(() => {
    const updateHeight = () => setViewportHeight(window.innerHeight || 720);
    updateHeight();
    window.addEventListener("resize", updateHeight);
    return () => window.removeEventListener("resize", updateHeight);
  }, []);

  const groups = useMemo(() => makeLiveGroups(rows), [rows]);
  const matchingRightRailHeight = getLiveRailHeight(viewportHeight);
  const tableHeight = Math.max(500, matchingRightRailHeight - 270);
  const activeRow = useMemo(() => {
    const current = String(currentClient || "").trim().toUpperCase();
    const processing = rows.find(getRowProcessing);
    if (processing) return processing;
    if (!current || current === "-") return null;
    return rows.find((row) => String(row.clientCode || "").trim().toUpperCase() === current) || null;
  }, [rows, currentClient]);
  const activeRowKey = activeRow
    ? activeRow.rowKey || getClientRowKey(activeRow.clientCode, activeRow.entityCode, activeRow.month)
    : "";

  useEffect(() => {
    if (!isAutomationRunning || !activeRow) return;
    const key = String(activeRow.clientCode || "").toUpperCase();
    if (key) setExpandedGroups((current) => ({ ...current, [key]: true }));
  }, [activeRow, isAutomationRunning]);

  return (
    <section>
      <div className="mb-3 flex flex-wrap gap-2">
        {[
          ["all", "All"],
          ["processed", "Processed"],
          ["failed", "Failed"]
        ].map(([value, label]) => (
          <button key={value} className={`btn btn-sm ${liveFilter === value ? (value === "failed" ? "btn-danger" : "btn-primary") : value === "failed" ? "btn-outline-danger" : "btn-outline-primary"}`} type="button" onClick={() => setLiveFilter(value)}>
            {label}
          </button>
        ))}
      </div>
      <div className="panel overflow-x-auto">
        <div className="flex min-w-[1180px] flex-col" style={{ minHeight: tableHeight }}>
          <div className="grid grid-cols-[13%_20%_10%_11%_14%_14%_18%] bg-[#f7faff] px-3 py-3 text-xs font-semibold uppercase tracking-normal text-[#49627d]">
            <div className="px-1 text-center">Company Code</div>
            <div className="px-1 text-center">Company Name</div>
            <div className="px-1 text-center">Entity</div>
            <div className="px-1 text-center">Period</div>
            <div className="px-1 text-center">HRIS Status</div>
            <div className="px-1 text-center">Paysheet Status</div>
            <div className="px-1 text-center">SFTP Path</div>
          </div>
          {groups.length ? (
            <div className="max-h-[calc(100vh-350px)] min-h-[310px] overflow-y-auto bg-white">
              {groups.map((group) => (
                <LiveCompanyGroup
                  key={group.key}
                  group={group}
                  isExpanded={Boolean(expandedGroups[group.key])}
                  onToggle={() => setExpandedGroups((current) => ({ ...current, [group.key]: !current[group.key] }))}
                  onSelect={onSelect}
                  activeRowKey={activeRowKey}
                />
              ))}
            </div>
          ) : (
            <LiveEmptyState />
          )}
        </div>
      </div>
    </section>
  );
}

function LiveEmptyState() {
  const skeletonRows = Array.from({ length: 5 });

  return (
    <div className="flex min-h-[310px] flex-1 flex-col border-t border-slate-100 bg-white">
      <div className="px-3">
        {skeletonRows.map((_, index) => (
          <div key={index} className="grid grid-cols-[13%_20%_10%_11%_14%_14%_18%] items-center border-b border-slate-100 py-3">
            <span className="mx-1 h-3 animate-pulse rounded bg-slate-100" />
            <span className="mx-1 h-3 animate-pulse rounded bg-slate-100" />
            <span className="mx-1 h-3 animate-pulse rounded bg-slate-100" />
            <span className="mx-1 h-3 animate-pulse rounded bg-slate-100" />
            <span className="mx-1 h-6 animate-pulse rounded-full bg-slate-100" />
            <span className="mx-1 h-6 animate-pulse rounded-full bg-slate-100" />
            <span className="mx-1 h-3 animate-pulse rounded bg-slate-100" />
          </div>
        ))}
      </div>
      <div className="flex flex-1 items-center justify-center px-6 py-6 text-center">
        <div>
          <p className="text-base font-semibold text-[#001f3f]">Start the automation</p>
          <p className="mt-1 text-sm text-slate-500">Company and entity progress will appear here as soon as the run begins.</p>
        </div>
      </div>
    </div>
  );
}

// SFTP shortcut screen. Credentials and headless settings live under Config > Settings.
function SftpTab({ onOpen }) {
  return (
    <section className="panel p-4">
      <h3 className="mb-2 text-sm font-semibold text-slate-500">SFTP Portal</h3>
      <p className="mb-3 text-sm text-slate-500">Open the SFTP website in a new tab.</p>
      <button className="btn btn-primary btn-sm" type="button" onClick={onOpen}><Icon name="external" />Open SFTP Portal</button>
    </section>
  );
}

// Historical database view grouped by month, year, and company filters.
function HistoryTab({ rows, months, years, companyOptions, month, year, company, setMonth, setYear, setCompany, onShowAll }) {
  const normalizeStatus = (value) => String(value || "").trim().toUpperCase();

  const formatDateTime = (value) => {
    if (!value) return "-";
    return String(value).replace("T", " ").slice(0, 19);
  };

  const getHrisStatus = (row) => {
    if (row.hrisStatus || row.hris_status) return row.hrisStatus || row.hris_status;
    if (row.hrisFilePath) return "SUCCESS";
    if (String(row.run_status || "").toUpperCase() === "FAILED") return "FAILED";
    return "PENDING";
  };

  const getPaysheetStatus = (row) => row.paysheetStatus || row.paysheet_status || row.status || "PENDING";
  const getUploadStatus = (row) => row.uploadStatus || row.upload_status || "PENDING";

  const summary = rows.reduce(
    (counts, row) => {
      const runStatus = normalizeStatus(row.run_status);
      const hrisStatus = normalizeStatus(getHrisStatus(row));
      const paysheetStatus = normalizeStatus(getPaysheetStatus(row));
      const uploadStatus = normalizeStatus(getUploadStatus(row));
      counts.total += 1;
      if ([runStatus, hrisStatus, paysheetStatus, uploadStatus].some((status) => status === "FAILED")) {
        counts.failed += 1;
        return counts;
      }
      if ([runStatus, hrisStatus, paysheetStatus, uploadStatus].every((status) => status === "COMPLETED" || status === "SUCCESS")) {
        counts.completed += 1;
      }
      return counts;
    },
    { total: 0, completed: 0, failed: 0 }
  );

  return (
    <section className="panel">
      <div className="border-b border-slate-200 p-4">
        <div className="mb-4 grid gap-4 xl:grid-cols-[minmax(260px,1fr)_minmax(720px,auto)] xl:items-end">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-slate-800">History</h3>
            <p className="text-sm text-slate-500">Completed automation runs and company status history</p>
          </div>
          <div className="grid w-full gap-2 md:grid-cols-[150px_150px_minmax(260px,1fr)_92px] xl:w-[820px] xl:justify-self-end xl:items-end">
            <label className="block text-sm text-slate-500">
              Period
              <select className="field mt-1" value={month} onChange={(event) => setMonth(event.target.value)}>
                <option value="">All Periods</option>
                {months.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            <label className="block text-sm text-slate-500">
              Year
              <select className="field mt-1" value={year} onChange={(event) => setYear(event.target.value)}>
                <option value="">All Years</option>
                {years.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            <label className="block text-sm text-slate-500">
              Company Name / Company ID
              <select className="field mt-1" value={company} onChange={(event) => setCompany(event.target.value)}>
                <option value="">All Companies</option>
                {companyOptions.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
              </select>
            </label>
            <button className="btn btn-outline-primary mt-6 h-[38px] whitespace-nowrap px-4 text-sm md:mt-5" type="button" onClick={onShowAll}>Show All</button>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-2.5">
            <p className="text-xs font-semibold uppercase text-slate-500">Records</p>
            <p className="text-xl font-semibold text-slate-900">{summary.total}</p>
          </div>
          <div className="rounded-md border border-emerald-100 bg-emerald-50 px-4 py-2.5">
            <p className="text-xs font-semibold uppercase text-emerald-700">Completed</p>
            <p className="text-xl font-semibold text-emerald-800">{summary.completed}</p>
          </div>
          <div className="rounded-md border border-red-100 bg-red-50 px-4 py-2.5">
            <p className="text-xs font-semibold uppercase text-red-700">Failed</p>
            <p className="text-xl font-semibold text-red-800">{summary.failed}</p>
          </div>
        </div>
      </div>

      <div className="max-h-[calc(100vh-305px)] min-h-[320px] overflow-auto">
        <table className="table min-w-[1400px] table-fixed">
          <colgroup>
            <col className="w-[9%]" />
            <col className="w-[15%]" />
            <col className="w-[8%]" />
            <col className="w-[8%]" />
            <col className="w-[8%]" />
            <col className="w-[9%]" />
            <col className="w-[10%]" />
            <col className="w-[10%]" />
            <col className="w-[12%]" />
            <col className="w-[11%]" />
          </colgroup>
          <thead>
            <tr>
              <th className="sticky top-0 z-10 text-center">Company ID</th>
              <th className="sticky top-0 z-10 text-center">Company Name</th>
              <th className="sticky top-0 z-10 text-center">Entity</th>
              <th className="sticky top-0 z-10 text-center">Period</th>
              <th className="sticky top-0 z-10 text-center">Run</th>
              <th className="sticky top-0 z-10 text-center">HRIS</th>
              <th className="sticky top-0 z-10 text-center">Paysheet</th>
              <th className="sticky top-0 z-10 text-center">Upload</th>
              <th className="sticky top-0 z-10 text-center">SFTP Path</th>
              <th className="sticky top-0 z-10 text-center">Completed At</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.map((row) => (
              <tr key={`${row.id}-${row.run_id || ""}-${row.client_code || ""}`}>
                <td className="text-center font-semibold text-[#001f3f]">{row.client_code || row.client_id || "-"}</td>
                <td className="truncate text-center" title={row.client_name || "-"}>{row.client_name || "-"}</td>
                <td className="text-center">{row.entity_code || "-"}</td>
                <td className="text-center">{row.period || row.month || "-"}</td>
                <td className="text-center"><StatusChip status={row.run_status || "PENDING"} /></td>
                <td className="text-center"><StatusChip status={getHrisStatus(row)} /></td>
                <td className="text-center"><StatusChip status={getPaysheetStatus(row)} /></td>
                <td className="text-center"><StatusChip status={getUploadStatus(row)} /></td>
                <td className="truncate text-center" title={row.sftp_path || row.file_path || "-"}>{row.sftp_path || row.file_path || "-"}</td>
                <td className="text-center">{formatDisplayDateTime(row.completed_at || row.started_at || row.created_at)}</td>
              </tr>
            )) : (
              <tr>
                <td colSpan="10" className="py-10 text-center text-slate-500">No history found for selected filters.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// Read-only database console for operational troubleshooting.
function DbTab({ sqlQuery, setSqlQuery, rows, columns, onExecute, onStop, onListTables, onRestoreCompleted }) {
  const [isBackupOpen, setIsBackupOpen] = useState(false);
  const [backups, setBackups] = useState([]);
  const [backupStatus, setBackupStatus] = useState("");
  const [isBackupLoading, setIsBackupLoading] = useState(false);
  const [restoringBackup, setRestoringBackup] = useState("");

  const fetchBackups = async () => {
    const response = await fetch("/backups");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not load backups.");
    setBackups(Array.isArray(data.backups) ? data.backups : []);
  };

  const loadBackups = async () => {
    setIsBackupOpen(true);
    setIsBackupLoading(true);
    setBackupStatus("Loading backups...");
    try {
      await fetchBackups();
      setBackupStatus("");
    } catch (err) {
      setBackupStatus(err.message || "Could not load backups.");
    } finally {
      setIsBackupLoading(false);
    }
  };

  const restoreBackup = async (name) => {
    if (!window.confirm(`Restore database backup ${name}? Current live data will be replaced.`)) return;
    setRestoringBackup(name);
    setBackupStatus("Restoring backup...");
    try {
      const response = await fetch("/backups/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not restore backup.");
      setBackupStatus(`Restored ${name}.`);
      await onRestoreCompleted?.();
      await fetchBackups();
    } catch (err) {
      setBackupStatus(err.message || "Could not restore backup.");
    } finally {
      setRestoringBackup("");
    }
  };

  const createManualBackup = async () => {
    setBackupStatus("Creating backup...");
    setIsBackupLoading(true);
    try {
      const response = await fetch("/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: "manual" })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not create backup.");
      setBackupStatus(`Created ${data.backup?.name || "backup"}.`);
      await fetchBackups();
    } catch (err) {
      setBackupStatus(err.message || "Could not create backup.");
    } finally {
      setIsBackupLoading(false);
    }
  };

  return (
    <section className="panel p-4">
      <h3 className="mb-2 text-sm font-semibold text-slate-500">Database Query Console</h3>
      <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        Full SQL access is enabled in this console. It now supports multi-statement scripts and commands like CREATE, ALTER, and DROP. Use carefully.
      </p>
      <textarea className="field min-h-32 font-mono text-sm" value={sqlQuery} onChange={(event) => setSqlQuery(event.target.value)} placeholder="Write SQL query or full SQL script here..." />
      <div className="my-3 flex flex-wrap gap-2">
        <button className="btn btn-primary btn-sm" type="button" onClick={onExecute}>Execute</button>
        <button className="btn btn-outline-danger btn-sm" type="button" onClick={onStop}>Stop</button>
        <button className="btn btn-outline-secondary btn-sm" type="button" onClick={onListTables}>List Tables</button>
        <button className="btn btn-outline-primary btn-sm" type="button" onClick={loadBackups}>
          <Icon name="database" />Backups
        </button>
      </div>
      <ResultTable rows={rows} columns={columns} />
      {isBackupOpen && (
        <Modal title="Database Backups" onClose={() => setIsBackupOpen(false)}>
          <div className="space-y-3">
            {backupStatus && (
              <p className={`rounded-md px-3 py-2 text-sm ${backupStatus.toLowerCase().includes("could not") || backupStatus.toLowerCase().includes("failed") ? "bg-red-50 text-red-700" : "bg-blue-50 text-[#001f3f]"}`}>
                {backupStatus}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <button className="btn btn-outline-primary btn-sm" type="button" onClick={createManualBackup} disabled={isBackupLoading}>
                <Icon name="database" />Create Backup
              </button>
              <button className="btn btn-outline-secondary btn-sm" type="button" onClick={loadBackups} disabled={isBackupLoading}>Refresh</button>
            </div>
            <div className="max-h-80 overflow-auto rounded-md border border-slate-200">
              <table className="table">
                <thead>
                  <tr>
                    <th>Backup File</th>
                    <th>Created</th>
                    <th>Size</th>
                    <th className="text-right">Restore</th>
                  </tr>
                </thead>
                <tbody>
                  {isBackupLoading ? (
                    <tr>
                      <td colSpan="4" className="py-8 text-center text-slate-500">Loading backup files...</td>
                    </tr>
                  ) : backups.length ? backups.map((backup) => (
                    <tr key={backup.name}>
                      <td className="font-mono text-xs">{backup.name}</td>
                      <td>{formatDisplayDateTime(backup.createdAt)}</td>
                      <td>{Math.max(1, Math.round((backup.size || 0) / 1024))} KB</td>
                      <td className="text-right">
                        <button className="btn btn-outline-primary btn-sm" type="button" onClick={() => restoreBackup(backup.name)} disabled={Boolean(restoringBackup)}>
                          {restoringBackup === backup.name ? "Restoring..." : "Restore"}
                        </button>
                      </td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan="4" className="py-8 text-center text-slate-500">No backup files found.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end gap-2">
              <button className="btn btn-outline-secondary" type="button" onClick={loadBackups}>Refresh</button>
              <button className="btn btn-primary" type="button" onClick={() => setIsBackupOpen(false)}>Close</button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

// Config hub separates operational client configuration, DB console, logs, and settings.
function ConfigHub({ activeSection, setActiveSection, clientConfigProps, dbProps, settingsProps, logs, selectedMonthYear, setSelectedMonthYear }) {
  const sections = [
    { id: "clientConfig", label: "Client Configuration", icon: "users" },
    { id: "db", label: "DB", icon: "database" },
    { id: "log", label: "Log", icon: "list" },
    { id: "settings", label: "Settings", icon: "settings" }
  ];

  return (
    <section className="space-y-4">
      <div className="panel flex flex-wrap gap-2 p-3">
        {sections.map((section) => (
          <button
            key={section.id}
            className={`btn btn-sm ${activeSection === section.id ? "btn-primary" : "btn-outline-primary"}`}
            type="button"
            onClick={() => setActiveSection(section.id)}
          >
            <Icon name={section.icon} />
            {section.label}
          </button>
        ))}
      </div>

      {activeSection === "clientConfig" && <ClientConfigurationTab {...clientConfigProps} />}
      {activeSection === "db" && <DbTab {...dbProps} />}
      {activeSection === "log" && <LogTab logs={logs} selectedMonthYear={selectedMonthYear} />}
      {activeSection === "settings" && <ConfigTab {...settingsProps} />}
    </section>
  );
}

// Automation log viewer with month-scoped CSV export.
function LogTab({ logs, selectedMonthYear }) {
  const selectedPeriod = normalizeRunMonth(selectedMonthYear);
  const periodLogs = useMemo(() => (
    logs.filter((line) => String(line).includes(`[${selectedPeriod}]`))
  ), [logs, selectedPeriod]);

  return (
    <section className="panel p-4">
      <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <h3 className="text-base font-semibold text-slate-800">Automation Log</h3>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm">
            <span className="text-slate-500">Period</span>
            <span className="font-semibold uppercase tracking-wide text-[#001f3f]">{selectedMonthYear}</span>
          </div>
          <button className="btn btn-primary" type="button" onClick={() => downloadLogsCsv(periodLogs, selectedMonthYear)}>
            <Icon name="download" />Download CSV
          </button>
        </div>
      </div>
      <div className="max-h-[calc(100vh-220px)] overflow-auto rounded-md border border-slate-200 bg-slate-950 p-3 font-mono text-sm text-slate-100">
        {periodLogs.length ? periodLogs.map((line) => (
          <div key={line} className="border-b border-white/10 py-1 last:border-b-0">{line}</div>
        )) : <div className="text-slate-400">No logs available for {selectedMonthYear}.</div>}
      </div>
    </section>
  );
}

const makeCompanyGroups = (rows) => {
  const map = new Map();
  rows.forEach((row) => {
    const companyId = row.client_id || row.client_code || "-";
    const key = String(companyId || "-").toUpperCase();
    if (!map.has(key)) {
      map.set(key, {
        key,
        companyId,
        companyName: row.client_name || "-",
        clientStatus: row.client_status || "ACTIVE",
        companyPath: row.sftp_path || row.file_path || "",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        rows: []
      });
    }
    const group = map.get(key);
    group.rows.push(row);
    if (!group.companyName || group.companyName === "-") group.companyName = row.client_name || group.companyName;
    if (!group.companyPath && (!row.entity_code || isNoEntityDefaultCode(row.entity_code))) group.companyPath = row.sftp_path || row.file_path || "";
    if (!group.createdAt) group.createdAt = row.created_at;
    if (row.updated_at) group.updatedAt = row.updated_at;
  });

  return Array.from(map.values()).map((group) => {
    const entityRows = group.rows.filter((row) => {
      const code = String(row.entity_code || "").trim();
      return code && !(group.rows.length === 1 && isNoEntityDefaultCode(code));
    });
    const noEntityRow = group.rows.find((row) => !String(row.entity_code || "").trim() || isNoEntityDefaultCode(row.entity_code)) || group.rows[0] || {};
    return {
      ...group,
      entityRows,
      entityCount: entityRows.length,
      noEntityRow,
      hasEntities: entityRows.length > 0,
      companyPath: group.companyPath || noEntityRow.sftp_path || noEntityRow.file_path || ""
    };
  });
};

function CompanyEntityRow({ row }) {
  const path = row.sftp_path || row.file_path || "-";
  const entityName = row.entity_name || row.name || "Entity";
  const entityStatus = row.status || "Pending";
  return (
    <div className="grid grid-cols-[18%_22%_18%_22%_20%] items-center border-t border-slate-100 bg-slate-50/70 px-4 py-3 text-center text-sm text-slate-700">
      <div className="truncate px-1 font-semibold text-[#001f3f]">{row.entity_code || "-"}</div>
      <div className="truncate px-1" title={entityName}>{entityName}</div>
      <div className="truncate px-1"><ClientStatusBadge status={entityStatus} /></div>
      <div className="truncate px-1" title={path}>{path}</div>
      <div className="truncate px-1">{formatDisplayDateTime(row.created_at)}</div>
    </div>
  );
}

function CompanyGroupRow({ group, isExpanded, onToggle }) {
  const canExpand = group.hasEntities;
  const pathLabel = group.hasEntities ? "View entity paths" : (group.companyPath || "-");

  return (
    <div className="border-t border-slate-100">
      <div className="grid grid-cols-[18%_22%_18%_22%_20%] items-center px-4 py-3 text-center text-sm text-slate-700 hover:bg-[#f7faff]">
        <div className="flex min-w-0 items-center justify-center gap-2 px-1 font-semibold text-[#001f3f]">
          {canExpand ? (
            <button
              type="button"
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-100"
              onClick={onToggle}
              aria-label={isExpanded ? "Hide entities" : "Show entities"}
            >
              {isExpanded ? "▼" : "▶"}
            </button>
          ) : (
            <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-slate-100 bg-slate-50 text-xs text-slate-400">—</span>
          )}
          <span className="truncate">{group.companyId}</span>
        </div>
        <div className="truncate px-1">{group.companyName || "-"}</div>
        <div className="truncate px-1 text-center">
          <ClientStatusBadge status={group.clientStatus} />
        </div>
        <div className="truncate px-1" title={pathLabel}>{pathLabel}</div>
        <div className="truncate px-1">{formatDisplayDateTime(group.createdAt)}</div>
      </div>
      {canExpand && isExpanded && (
        <div>
          {group.entityRows.map((row, index) => (
            <CompanyEntityRow key={`${group.key}-${row.entity_code || index}`} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

// Top-level Companies tab. Pagination intentionally limits visible companies to 50 while
// the download button exports the full filtered list.
function ClientsTab({ rows, search, setSearch, refreshCompanies }) {
  const pageSize = 50;
  const [page, setPage] = useState(1);
  const [expandedCompanies, setExpandedCompanies] = useState({});
  const groupedRows = useMemo(() => makeCompanyGroups(rows), [rows]);
  const totalPages = Math.max(1, Math.ceil(groupedRows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const pageRows = groupedRows.slice(startIndex, startIndex + pageSize);
  const [viewportHeight, setViewportHeight] = useState(() => {
    if (typeof window === "undefined") return 720;
    return window.innerHeight || 720;
  });

  useEffect(() => {
    setPage(1);
  }, [rows.length, search]);

  useEffect(() => {
    const updateHeight = () => {
      setViewportHeight(window.innerHeight || 720);
    };

    updateHeight();
    window.addEventListener("resize", updateHeight);
    return () => window.removeEventListener("resize", updateHeight);
  }, []);

  const panelHeight = Math.max(560, viewportHeight - 128);
  const paginationHeight = groupedRows.length > pageSize ? 76 : 0;
  const listHeight = Math.max(280, panelHeight - 118 - paginationHeight);

  useEffect(() => {
    if (!search.trim()) return;
    const searchValue = search.trim().toLowerCase();
    const nextExpanded = {};
    groupedRows.forEach((group) => {
      const entityMatch = group.entityRows.some((row) => `${row.entity_code || ""} ${row.entity_name || ""} ${row.sftp_path || row.file_path || ""}`.toLowerCase().includes(searchValue));
      if (entityMatch) nextExpanded[group.key] = true;
    });
    if (Object.keys(nextExpanded).length) setExpandedCompanies((current) => ({ ...current, ...nextExpanded }));
  }, [groupedRows, search]);

  const downloadClientsXlsx = () => {
    if (!rows.length) return;

    const columns = ["client_id", "client_name", "entity_code", "sftp_path", "created_at"];
    const header = ["Company ID", "Company Name", "Entity Code", "SFTP Path", "Added On"];
    const workbookRows = [
      header,
      ...rows.map((row) => columns.map((column) => row[column] ?? ""))
    ];
    const blob = createXlsxBlob(workbookRows);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "companies-list.xlsx";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="panel flex min-h-[560px] flex-col overflow-hidden" style={{ height: panelHeight }}>
      <div className="flex flex-col gap-3 border-b border-slate-200 p-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h3 className="text-base font-semibold text-slate-800">Companies</h3>
          <p className="text-sm text-slate-500">Companies are shown once. Expand a company to see its entities.</p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:flex-row md:max-w-xl">
          <label className="relative block flex-1">
            <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input className="field pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search company ID, name, entity, or path" />
          </label>
          <button className="btn btn-outline-primary" type="button" disabled={!rows.length} onClick={downloadClientsXlsx}>
            <Icon name="download" />Download
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div className="flex h-full min-w-[920px] flex-col">
          <div className="grid grid-cols-[18%_22%_18%_22%_20%] bg-[#f7faff] px-4 py-3 text-center text-xs font-semibold uppercase tracking-normal text-[#49627d]">
            <div className="px-1">Company ID</div>
            <div className="px-1 text-center">Company Name</div>
            <div className="px-1">Status</div>
            <div className="px-1">Path / Entity Paths</div>
            <div className="px-1">Added On</div>
          </div>
          {pageRows.length ? (
            <div className="min-h-0 flex-1 overflow-y-auto" style={{ maxHeight: listHeight }}>
              {pageRows.map((group) => (
                <CompanyGroupRow
                  key={group.key}
                  group={group}
                  isExpanded={Boolean(expandedCompanies[group.key])}
                  onToggle={() => setExpandedCompanies((current) => ({ ...current, [group.key]: !current[group.key] }))}
                  />
              ))}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center border-t border-slate-100 text-sm text-slate-500">No companies loaded.</div>
          )}
        </div>
      </div>

      {groupedRows.length > pageSize && (
        <div className="flex flex-col gap-3 border-t border-slate-200 bg-white p-4 text-sm text-slate-600 sm:flex-row sm:items-center sm:justify-between">
          <div>
            Showing {startIndex + 1}-{Math.min(startIndex + pageSize, groupedRows.length)} of {groupedRows.length} companies
          </div>
          <div className="flex items-center gap-2">
            <button className="btn btn-outline-secondary btn-sm" type="button" disabled={currentPage === 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
              Previous
            </button>
            <span className="min-w-20 text-center font-semibold text-slate-700">
              {currentPage} / {totalPages}
            </span>
            <button className="btn btn-outline-secondary btn-sm" type="button" disabled={currentPage === totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>
              Next
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// Build a minimal XLSX workbook in the browser. This avoids adding another
// frontend dependency while still producing a real Excel file.
function createXlsxBlob(rows) {
  const worksheet = buildWorksheetXml(rows);
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Companies" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    "xl/worksheets/sheet1.xml": worksheet,
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellXfs>
</styleSheet>`
  };

  return new Blob([zipFiles(files)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
}

// Generate worksheet XML using inline strings so no shared string table is needed.
function buildWorksheetXml(rows) {
  const sheetRows = rows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const cells = row.map((value, columnIndex) => {
      const cellRef = `${columnName(columnIndex)}${rowNumber}`;
      return `<c r="${cellRef}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
    }).join("");
    return `<row r="${rowNumber}">${cells}</row>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${sheetRows}</sheetData>
</worksheet>`;
}

// Convert a zero-based column index into Excel column notation: 0 -> A, 26 -> AA.
function columnName(index) {
  let name = "";
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

// XML escaping is required because company names and paths can contain reserved characters.
function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Store-only ZIP writer for small workbook exports. XLSX files are ZIP archives;
// this implementation creates uncompressed entries with valid CRC values.
function zipFiles(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  Object.entries(files).forEach(([name, content]) => {
    const nameBytes = encoder.encode(name);
    const contentBytes = encoder.encode(content);
    const crc = crc32(contentBytes);
    const localHeader = zipLocalHeader(nameBytes, contentBytes.length, crc);
    localParts.push(localHeader, contentBytes);
    centralParts.push(zipCentralHeader(nameBytes, contentBytes.length, crc, offset));
    offset += localHeader.length + contentBytes.length;
  });

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const endRecord = zipEndRecord(Object.keys(files).length, centralSize, offset);
  return new Blob([...localParts, ...centralParts, endRecord]);
}

// ZIP local file header for one workbook part.
function zipLocalHeader(nameBytes, size, crc) {
  const bytes = new Uint8Array(30 + nameBytes.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(8, 0, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, nameBytes.length, true);
  bytes.set(nameBytes, 30);
  return bytes;
}

// ZIP central directory entry for one workbook part.
function zipCentralHeader(nameBytes, size, crc, offset) {
  const bytes = new Uint8Array(46 + nameBytes.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(10, 0, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, nameBytes.length, true);
  view.setUint32(42, offset, true);
  bytes.set(nameBytes, 46);
  return bytes;
}

// ZIP end-of-central-directory record.
function zipEndRecord(count, centralSize, centralOffset) {
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  return bytes;
}

// CRC32 is required by ZIP readers, including Excel.
function crc32(bytes) {
  let crc = -1;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[index]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

// Precomputed CRC lookup table keeps export generation fast and deterministic.
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

// Editable row in the Config > Client Configuration table.
function ClientConfigVirtualRow({ index, style, data }) {
  const { rows, selectedGroupKey, onSelect } = data;
  const row = rows[index];
  const groupKey = row.client_group_key || row.client_id || row.client_code || "";
  const isSelected = String(selectedGroupKey) === String(groupKey);

  const displayId = row.client_master_id || row.master_id || row.id || "-";
  const displayEntityCode = row.entity_code_display || row.entity_code || (row.has_entities ? "-" : "001");

  return (
    <div
      className={`grid cursor-pointer grid-cols-[7%_14%_20%_12%_23%_10%_10%_4%] items-center border-t border-slate-100 px-4 text-center text-sm text-slate-700 ${isSelected ? "bg-blue-50" : "hover:bg-[#f7faff]"}`}
      style={style}
      onClick={() => onSelect(row)}
    >
      <div className="truncate px-1">{displayId}</div>
      <div className="truncate px-1">{row.client_id || row.client_code || "-"}</div>
      <div className="truncate px-1">{row.client_name || "-"}</div>
      <div className="truncate px-1">{displayEntityCode}</div>
      <div className="truncate px-1" title={row.sftp_path || row.file_path || ""}>
        {row.has_entities ? "Managed per entity" : (row.sftp_path || row.file_path || "-")}
      </div>
      <div className="truncate px-1">{formatDisplayDateTime(row.created_at)}</div>
      <div className="truncate px-1">{formatDisplayDateTime(row.updated_at)}</div>
      <div className="truncate px-1">{row.modified_by || "System"}</div>
    </div>
  );
}

// Client maintenance form used by operations to add, update, and delete rows.
function ClientConfigurationTab({ rows, search, setSearch, form, setForm, status, onSelect, onAdd, onUpdate, onDelete, onClear, onUploadOpen }) {
  const listHeight = Math.min(Math.max(rows.length, 1) * 52, 560);

  const updateField = (field, value) => {
    setForm((current) => normalizeClientConfigForm({ ...current, [field]: value }));
  };

  const updateEntityField = (index, field, value) => {
    setForm((current) => normalizeClientConfigForm({
      ...current,
      entities: current.entities.map((entity, entityIndex) => (entityIndex === index ? { ...entity, [field]: value } : entity))
    }));
  };

  const addEntityRow = () => {
    setForm((current) => normalizeClientConfigForm({
      ...current,
      has_entities: true,
      entityTab: "entities",
      entities: [...(current.entities || []), createEmptyEntityRow()]
    }));
  };

  const removeEntityRow = (index) => {
    setForm((current) => {
      const nextEntities = current.entities.filter((_, entityIndex) => entityIndex !== index);
      return normalizeClientConfigForm({
        ...current,
        entities: nextEntities.length ? nextEntities : [createEmptyEntityRow()]
      });
    });
  };

  const toggleEntities = (checked) => {
    setForm((current) => normalizeClientConfigForm({
      ...current,
      has_entities: checked,
      entityTab: checked ? "entities" : "company",
      entities: checked && current.entities?.length ? current.entities : [createEmptyEntityRow()]
    }));
  };

  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_430px]">
      <div className="panel flex max-h-[calc(100vh-150px)] flex-col overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-200 p-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-800">Client Configuration</h3>
            <p className="text-sm text-slate-500">Database company list</p>
          </div>
          <label className="relative block w-full md:max-w-sm">
            <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input className="field pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search company ID, name, or path" />
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-x-auto">
          <div className="min-w-[1280px]">
            <div className="grid grid-cols-[7%_14%_20%_12%_23%_10%_10%_4%] bg-[#f7faff] px-4 py-3 text-center text-xs font-semibold uppercase tracking-normal text-[#49627d]">
              <div className="px-1">ID</div>
              <div className="px-1">Company ID</div>
              <div className="px-1">Company Name</div>
              <div className="px-1">Entity Code</div>
              <div className="px-1">SFTP Path</div>
              <div className="px-1">Added On</div>
              <div className="px-1">Modified On</div>
              <div className="px-1">Modified By</div>
            </div>
            <div className="flex items-center gap-2 border-t border-red-100 bg-red-50 px-4 py-2 text-xs font-semibold text-red-700">
              <Icon name="warning" className="h-4 w-4 shrink-0" />
              <span>Company ID should be the same as the Vista Company ID.</span>
            </div>
            {rows.length ? (
              <List
                height={listHeight}
                itemCount={rows.length}
                itemData={{ rows, selectedGroupKey: form.client_group_key || form.client_id, onSelect }}
                itemKey={(index, data) => data.rows[index].client_group_key ?? data.rows[index].client_id ?? data.rows[index].client_code ?? index}
                itemSize={52}
                width="100%"
              >
                {ClientConfigVirtualRow}
              </List>
            ) : (
              <div className="border-t border-slate-100 py-8 text-center text-sm text-slate-500">No companies found.</div>
            )}
          </div>
        </div>
      </div>

      <div className="panel p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-800">{form.client_group_key ? "Edit Company" : "Add Company"}</h3>
          <div className="flex items-center gap-2">
            <button className="btn btn-outline-primary btn-sm" type="button" onClick={onUploadOpen}>
              <Icon name="upload" />Upload Excel
            </button>
            <button className="btn btn-outline-secondary btn-sm" type="button" onClick={onClear}>Clear</button>
          </div>
        </div>

        <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-700">Enable Entities</p>
              <p className="text-xs text-slate-500">When enabled, you can add and save any number of entities for the company.</p>
            </div>
            <label className="relative inline-flex cursor-pointer items-center">
              <input type="checkbox" className="peer sr-only" checked={Boolean(form.has_entities)} onChange={(event) => toggleEntities(event.target.checked)} />
              <span className="h-6 w-11 rounded-full bg-slate-300 transition peer-checked:bg-blue-600" />
              <span className="pointer-events-none absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition peer-checked:translate-x-5" />
            </label>
          </div>
        </div>

        <div className="mb-4 flex gap-2">
          <button className={`btn ${form.entityTab !== "entities" ? "btn-primary" : "btn-outline-secondary"}`} type="button" onClick={() => updateField("entityTab", "company")}>
            Company
          </button>
          {form.has_entities && (
            <button className={`btn ${form.entityTab === "entities" ? "btn-primary" : "btn-outline-secondary"}`} type="button" onClick={() => updateField("entityTab", "entities")}>
              Entity Tab
            </button>
          )}
        </div>

        {(form.entityTab !== "entities" || !form.has_entities) && (
          <div className="space-y-3">
            <label className="block text-sm text-slate-500">
              Company Name
              <input className="field mt-1" value={form.client_name} onChange={(event) => updateField("client_name", event.target.value)} onBlur={(event) => updateField("client_name", titleCaseClientName(event.target.value))} placeholder="Company name" />
            </label>
            <label className="block text-sm text-slate-500">
              Company ID
              <input className="field mt-1" value={form.client_id || form.client_code} onChange={(event) => { updateField("client_id", event.target.value); updateField("client_code", event.target.value); }} onBlur={(event) => { const value = cleanInputText(event.target.value); updateField("client_id", value); updateField("client_code", value); }} placeholder="Company ID" />
            </label>
            {!form.has_entities && (
              <label className="block text-sm text-slate-500">
                Entity Code
                <input className="field mt-1 bg-slate-100 text-slate-600" value="001" readOnly />
              </label>
            )}
            {!form.has_entities && (
              <label className="block text-sm text-slate-500">
                SFTP Path
                <input className="field mt-1" value={form.sftp_path || form.file_path} onChange={(event) => { updateField("sftp_path", event.target.value); updateField("file_path", event.target.value); }} onBlur={(event) => { const value = cleanInputText(event.target.value); updateField("sftp_path", value); updateField("file_path", value); }} placeholder="SFTP path" />
              </label>
            )}
          </div>
        )}

        {form.entityTab === "entities" && form.has_entities && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-700">Entity Configuration</p>
                <p className="text-xs text-slate-500">Add any number of entities and their SFTP paths.</p>
              </div>
              <button className="btn btn-outline-primary btn-sm" type="button" onClick={addEntityRow}>
                <Icon name="plus" />Add Entity
              </button>
            </div>

            <div className="space-y-3">
              {form.entities.map((entity, index) => (
                <div key={entity.id || index} className="rounded-2xl border border-slate-200 p-3">
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-sm font-semibold text-slate-700">Entity {index + 1}</p>
                    <button className="btn btn-outline-danger btn-sm" type="button" onClick={() => removeEntityRow(index)} disabled={form.entities.length === 1}>
                      <Icon name="trash" />Remove
                    </button>
                  </div>
                  <div className="grid gap-3">
                    <label className="block text-sm text-slate-500">
                      Entity Code
                      <input className="field mt-1" value={entity.entity_code} onChange={(event) => updateEntityField(index, "entity_code", event.target.value)} onBlur={(event) => updateEntityField(index, "entity_code", cleanInputText(event.target.value))} placeholder="Entity code" />
                    </label>
                    <label className="block text-sm text-slate-500">
                      SFTP Path
                      <input className="field mt-1" value={entity.sftp_path || entity.file_path} onChange={(event) => { updateEntityField(index, "sftp_path", event.target.value); updateEntityField(index, "file_path", event.target.value); }} onBlur={(event) => { const value = cleanInputText(event.target.value); updateEntityField(index, "sftp_path", value); updateEntityField(index, "file_path", value); }} placeholder="SFTP path" />
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <button className="btn btn-success" type="button" onClick={onAdd}>
            <Icon name="plus" />Add
          </button>
          <button className="btn btn-primary" type="button" onClick={onUpdate}>
            <Icon name="save" />Update
          </button>
          <button className="btn btn-danger" type="button" onClick={onDelete}>
            <Icon name="trash" />Delete
          </button>
        </div>
        {status && <p className="mt-3 text-sm text-slate-500">{status}</p>}
      </div>
    </section>
  );
}

// Settings screen for SFTP connection details and automation visibility options.

function StopProcessTab({ companies, stopRows, form, setForm, entityOptions, status, onAdd, onRemove }) {
  const selectedCompany = companies.find((item) => String(item.rows[0]?.clientMasterId || item.rows[0]?.client_master_id || '') === String(form.companyId || ''));

  useEffect(() => {
    if (!form.companyId) return;
    if (!entityOptions.some((item) => item.value === form.entityCode)) {
      setForm((previous) => ({
        ...previous,
        entityCode: entityOptions[0]?.value || ''
      }));
    }
  }, [entityOptions, form.companyId, form.entityCode, setForm]);

  return (
    <section className="space-y-4">
      <div className="panel p-5">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_auto] md:items-end">
          <label className="space-y-2">
            <span className="text-sm font-semibold text-slate-700">Company</span>
            <select
              className="field"
              value={form.companyId}
              onChange={(event) => setForm({ companyId: event.target.value, entityCode: '' })}
            >
              <option value="">Select company</option>
              {companies.map((group) => {
                const companyId = group.rows[0]?.clientMasterId || group.rows[0]?.client_master_id || '';
                return (
                  <option key={companyId} value={companyId}>
                    {(group.companyId || '-') + ' - ' + (group.companyName || '-')}
                  </option>
                );
              })}
            </select>
          </label>

          <label className="space-y-2">
            <span className="text-sm font-semibold text-slate-700">Entity Code</span>
            <select
              className="field"
              value={form.entityCode}
              onChange={(event) => setForm((previous) => ({ ...previous, entityCode: event.target.value }))}
              disabled={!form.companyId}
            >
              <option value="">Select entity</option>
              {entityOptions.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </label>

          <button className="btn btn-danger" type="button" onClick={onAdd}>
            <Icon name="stop" />Add Stop Process
          </button>
        </div>
        {selectedCompany && (
          <p className="mt-3 text-xs text-slate-500">
            Selected company: <span className="font-semibold text-slate-700">{selectedCompany.companyId}</span>
            {selectedCompany.companyName ? ` - ${selectedCompany.companyName}` : ''}
          </p>
        )}
        {status ? <p className="mt-3 text-sm font-medium text-[#001f3f]">{status}</p> : null}
      </div>

      <div className="panel overflow-hidden">
        <div className="grid grid-cols-[18%_28%_16%_20%_18%] bg-slate-100/80 px-4 py-3 text-center text-xs font-semibold uppercase tracking-normal text-slate-500">
          <div>Company Code</div>
          <div>Company Name</div>
          <div>Entity</div>
          <div>Done By</div>
          <div>Time</div>
        </div>
        {stopRows.length ? stopRows.map((row) => (
          <div key={row.id} className="grid grid-cols-[18%_28%_16%_20%_18%] items-center border-t border-slate-100 px-4 py-3 text-center text-sm text-slate-700">
            <div className="font-semibold text-[#001f3f]">{row.client_code || '-'}</div>
            <div>{row.client_name || '-'}</div>
            <div>{row.entity_code || '001'}</div>
            <div>
              <div>{row.done_by || '-'}</div>
              <button className="btn btn-sm btn-outline-primary mt-2" type="button" onClick={() => onRemove(row.id)}>
                Release
              </button>
            </div>
            <div>{formatDisplayDateTime(row.created_at)}</div>
          </div>
        )) : (
          <div className="px-4 py-8 text-center text-sm text-slate-500">No stop process records added.</div>
        )}
      </div>
    </section>
  );
}


function UsersTab({ authUsers, status, onChange, onSave }) {
  const roles = [
    { key: 'admin', label: 'Admin User' },
    { key: 'user', label: 'Normal User' }
  ];

  return (
    <section className="space-y-4">
      <div className="panel p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-800">Users</h3>
            <p className="mt-1 text-sm text-slate-500">This tab is visible only for admin. Edit username and password for both admin and user accounts.</p>
          </div>
          <button className="btn btn-primary" type="button" onClick={onSave}>
            <Icon name="save" />Save Users
          </button>
        </div>
        {status ? <p className="mt-3 text-sm font-medium text-[#001f3f]">{status}</p> : null}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="panel p-5">
          <p className="text-xs font-semibold uppercase text-slate-500">Number of Users</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{roles.length}</p>
        </div>
        <div className="panel p-5">
          <p className="text-xs font-semibold uppercase text-slate-500">Admin Username</p>
          <p className="mt-2 text-lg font-semibold text-[#001f3f]">{authUsers.admin?.username || '-'}</p>
        </div>
        <div className="panel p-5">
          <p className="text-xs font-semibold uppercase text-slate-500">User Username</p>
          <p className="mt-2 text-lg font-semibold text-[#001f3f]">{authUsers.user?.username || '-'}</p>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {roles.map((role) => (
          <div key={role.key} className="panel p-5">
            <div className="mb-4 flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#001f3f] text-white">
                <Icon name="users" />
              </span>
              <div>
                <h4 className="text-sm font-semibold text-slate-800">{role.label}</h4>
                <p className="text-xs text-slate-500">Manage login credentials for the {role.key} account.</p>
              </div>
            </div>
            <div className="space-y-4">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-600">Username</span>
                <input
                  className="field"
                  type="text"
                  value={authUsers[role.key]?.username || ''}
                  onChange={(event) => onChange(role.key, 'username', event.target.value)}
                  placeholder={role.key}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-600">Password</span>
                <input
                  className="field"
                  type="text"
                  value={authUsers[role.key]?.password || ''}
                  onChange={(event) => onChange(role.key, 'password', event.target.value)}
                  placeholder="Enter password"
                />
              </label>
            </div>
          </div>
        ))}
      </div>

      <div className="panel overflow-hidden">
        <div className="grid grid-cols-[16%_12%_36%_36%] bg-slate-100/80 px-4 py-3 text-center text-xs font-semibold uppercase tracking-normal text-slate-500">
          <div>S No</div>
          <div>Role</div>
          <div>Username</div>
          <div>Password</div>
        </div>
        {roles.map((role, index) => (
          <div key={`summary-${role.key}`} className="grid grid-cols-[16%_12%_36%_36%] items-center border-t border-slate-100 px-4 py-3 text-center text-sm text-slate-700">
            <div className="font-semibold text-slate-600">{index + 1}</div>
            <div className="font-semibold text-[#001f3f] uppercase">{role.key}</div>
            <div>{authUsers[role.key]?.username || '-'}</div>
            <div>{authUsers[role.key]?.password || '-'}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ConfigTab({ config, setConfig, status, setStatus, withSpinner }) {
  const [editingCredentials, setEditingCredentials] = useState({
    sftpUrl: false,
    sftpUser: false,
    sftpPass: false
  });

  const save = async (nextConfig = config, message = "Configuration saved.") => {
    await withSpinner("Saving configuration...", async () => {
      try {
        const res = await fetch("/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sftpUrl: nextConfig.sftpUrl || "",
            sftpUser: nextConfig.sftpUser || "",
            sftpPass: nextConfig.sftpPass || "",
            vistaHeadless: Boolean(nextConfig.vistaHeadless),
            sftpHeadless: Boolean(nextConfig.sftpHeadless)
          })
        });
        if (!res.ok) throw new Error("Settings update failed");
        setStatus(message);
      } catch {
        setStatus("Could not save backend settings.");
      }
    });
  };

  const updateField = (field, value) => {
    setConfig((current) => ({ ...current, [field]: value }));
  };

  const toggleCredentialEdit = (field) => {
    setEditingCredentials((current) => ({ ...current, [field]: !current[field] }));
  };

  const toggleSetting = (field) => {
    setConfig((value) => {
      const nextConfig = { ...value, [field]: !value[field] };
      save(nextConfig, `${field === "sftpHeadless" ? "SFTP" : "Vista"} headless ${nextConfig[field] ? "enabled" : "disabled"}.`);
      return nextConfig;
    });
  };

  return (
    <section className="panel p-4">
      <h3 className="mb-2 text-sm font-semibold text-slate-500">Configuration</h3>
      <div className="space-y-3">
        <CredentialSetting
          label="SFTP Portal URL"
          value={config.sftpUrl}
          editing={editingCredentials.sftpUrl}
          placeholder="Enter SFTP portal URL"
          onChange={(value) => updateField("sftpUrl", value)}
          onToggleEdit={() => toggleCredentialEdit("sftpUrl")}
        />

        <div className="grid gap-3 md:grid-cols-2">
          <CredentialSetting
            label="SFTP Username"
            value={config.sftpUser}
            editing={editingCredentials.sftpUser}
            placeholder="Enter SFTP username"
            onChange={(value) => updateField("sftpUser", value)}
            onToggleEdit={() => toggleCredentialEdit("sftpUser")}
          />
          <CredentialSetting
            label="SFTP Password"
            value={config.sftpPass}
            editing={editingCredentials.sftpPass}
            placeholder="Enter SFTP password"
            masked
            onChange={(value) => updateField("sftpPass", value)}
            onToggleEdit={() => toggleCredentialEdit("sftpPass")}
          />
        </div>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-2">
        <ToggleSetting
          label="Vista Headless"
          checked={Boolean(config.vistaHeadless)}
          onChange={() => {
            const nextConfig = {
              ...config,
              vistaHeadless: !config.vistaHeadless,
              sftpHeadless: !config.vistaHeadless
            };
            setConfig(nextConfig);
            save(nextConfig, `Vista headless ${nextConfig.vistaHeadless ? "enabled" : "disabled"}.`);
          }}
        />
        <ToggleSetting
          label="SFTP Headless"
          checked={Boolean(config.sftpHeadless)}
          onChange={() => toggleSetting("sftpHeadless")}
        />
      </div>

      <button className="btn btn-outline-primary btn-sm mt-3" type="button" onClick={() => save()}>Save Config</button>
      {status && <div className="mt-2 text-sm text-slate-500">{status}</div>}
    </section>
  );
}

function CredentialSetting({ label, value, editing, masked = false, placeholder, onChange, onToggleEdit }) {
  const displayValue = value ? (masked ? "********" : value) : "Not configured";

  return (
    <div className="rounded-md border border-[#dbe5f0] bg-[#f7faff] p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-slate-600">{label}</span>
        <button
          className="btn btn-outline-primary btn-sm !px-2"
          type="button"
          onClick={onToggleEdit}
          title={editing ? `Lock ${label}` : `Edit ${label}`}
          data-audit-label={editing ? `Lock ${label}` : `Edit ${label}`}
        >
          <Icon name={editing ? "check" : "edit"} className="h-4 w-4" />
        </button>
      </div>
      {editing ? (
        <input
          className="field"
          type={masked ? "password" : "text"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete={masked ? "current-password" : "username"}
        />
      ) : (
        <div className={`rounded-md border border-[#c9d6e6] bg-white px-3 py-2 text-sm ${value ? "text-slate-800" : "text-slate-400"}`}>
          {displayValue}
        </div>
      )}
    </div>
  );
}

// Accessible switch-style checkbox used by Settings.
function ToggleSetting({ label, checked, onChange }) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-md border border-slate-200 bg-[#f7faff] px-4 py-3 text-sm font-semibold text-slate-700">
      <span>{label}</span>
      <input className="sr-only" type="checkbox" checked={checked} onChange={onChange} />
      <span className={`relative inline-flex h-7 w-12 shrink-0 rounded-full transition ${checked ? "bg-[#001f3f]" : "bg-slate-300"}`} aria-hidden="true">
        <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition ${checked ? "left-6" : "left-1"}`} />
      </span>
    </label>
  );
}

// Right-side live status panel: notifications first, then log lines scoped to the selected company row.
function RightStatusPanel({ logs = [], notifications = [], selectedRecord, isAutomationRunning, isAutomationPaused }) {
  const [viewportHeight, setViewportHeight] = useState(() => {
    if (typeof window === "undefined") return 720;
    return window.innerHeight || 720;
  });
  const notificationsRef = useRef(null);
  const logsRef = useRef(null);

  const selectedLogs = useMemo(() => {
    if (!selectedRecord?.clientCode) return [];
    const companyIdPattern = new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(selectedRecord.clientCode)}([^A-Za-z0-9]|$)`, "i");
    return logs.filter((line) => companyIdPattern.test(String(line))).slice(0, 80);
  }, [logs, selectedRecord]);

  const visibleLogs = selectedRecord ? selectedLogs : logs.slice(0, 120);
  const statusText = isAutomationPaused ? "Paused" : isAutomationRunning ? "Running" : "Ready";
  const railHeight = getLiveRailHeight(viewportHeight);
  const rightPanelGap = 12;
  const rightPanelHeight = Math.floor((railHeight - rightPanelGap) / 2);

  useEffect(() => {
    const updateHeight = () => setViewportHeight(window.innerHeight || 720);
    updateHeight();
    window.addEventListener("resize", updateHeight);
    return () => window.removeEventListener("resize", updateHeight);
  }, []);

  useEffect(() => {
    if (notificationsRef.current) notificationsRef.current.scrollTop = 0;
  }, [notifications[0]]);

  useEffect(() => {
    if (logsRef.current) logsRef.current.scrollTop = 0;
  }, [visibleLogs[0], selectedRecord?.clientCode, selectedRecord?.entityCode]);

  return (
    <aside className="flex min-h-0 flex-col gap-3 lg:sticky lg:top-[104px]" style={{ height: railHeight }}>
      <section className="panel flex min-h-0 shrink-0 flex-col p-3" style={{ height: rightPanelHeight }}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="inline-flex items-center gap-2 text-sm font-semibold text-slate-700">
            <Icon name="bell" className="h-4 w-4 text-[#001f3f]" />
            Notifications
          </h3>
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${isAutomationRunning ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
            {statusText}
          </span>
        </div>
        <div ref={notificationsRef} className="scrollbar-hidden min-h-0 flex-1 space-y-2 overflow-auto">
          {notifications.length ? notifications.map((line, index) => (
            <div key={`${line}-${index}`} className="break-words rounded-md border border-slate-200 bg-[#f7faff] px-3 py-2 text-xs leading-5 text-slate-600">
              {line}
            </div>
          )) : (
            <NotificationSkeleton />
          )}
        </div>
      </section>

      <section className="panel flex min-h-0 flex-col overflow-hidden p-3" style={{ height: rightPanelHeight }}>
        <div className="mb-3 shrink-0">
          <h3 className="inline-flex items-center gap-2 text-sm font-semibold text-slate-700">
            <Icon name="activity" className="h-4 w-4 text-[#001f3f]" />
            Live Logs
          </h3>
          {selectedRecord ? (
            <p className="mt-1 text-xs text-slate-500">
              Showing logs for {selectedRecord.clientName || "Company"} ({selectedRecord.clientCode || "-"})
              {selectedRecord.entityCode && selectedRecord.entityCode !== "-" ? ` / Entity ${selectedRecord.entityCode}` : ""}
            </p>
          ) : (
            <p className="mt-1 text-xs text-slate-500">Select a row to view company-specific logs.</p>
          )}
        </div>

        {selectedRecord && (
          <div className="mb-2 grid shrink-0 grid-cols-2 gap-2 rounded-md border border-slate-200 bg-[#f7faff] p-2 text-xs text-slate-600">
            <div>
              <span className="block font-semibold uppercase text-[#49627d]">Company ID</span>
              {selectedRecord.clientCode || "-"}
            </div>
            <div>
              <span className="block font-semibold uppercase text-[#49627d]">Entity</span>
              {selectedRecord.entityCode || "-"}
            </div>
            <div>
              <span className="block font-semibold uppercase text-[#49627d]">HRIS</span>
              {selectedRecord.hrisStatus || selectedRecord.downloadStatus || "-"}
            </div>
            <div>
              <span className="block font-semibold uppercase text-[#49627d]">Upload</span>
              {selectedRecord.uploadStatus || "-"}
            </div>
          </div>
        )}

        <div ref={logsRef} className="scrollbar-hidden min-h-0 flex-1 overflow-auto rounded-md border border-slate-200 bg-slate-950 p-3 font-mono text-xs text-slate-100">
          {visibleLogs.length ? visibleLogs.map((line, index) => (
            <div key={`${line}-${index}`} className="break-words border-b border-white/10 py-1.5 leading-5 last:border-b-0">{line}</div>
          )) : (
            <div className="py-6 text-center text-slate-400">
              {selectedRecord ? "No logs found for the selected company yet." : "No live logs available."}
            </div>
          )}
        </div>
      </section>
    </aside>
  );
}

function NotificationSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="rounded-md border border-slate-200 bg-white px-3 py-2">
          <div className="mb-2 h-3 w-2/5 animate-pulse rounded bg-slate-100" />
          <div className="h-3 w-full animate-pulse rounded bg-slate-100" />
          <div className="mt-2 h-3 w-4/5 animate-pulse rounded bg-slate-100" />
        </div>
      ))}
    </div>
  );
}

// Small client table used inside the database/history side areas.
function DbSideTable({ rows, onSelect }) {
  return (
    <div className="max-h-[420px] overflow-auto">
      <table className="table min-w-[420px] text-xs">
        <thead>
          <tr>
            <th>ID</th>
            <th>Company ID</th>
            <th>Entity</th>
            <th>Period</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? rows.map((row) => (
            <tr key={row.id ?? row.entity_id ?? row.client_id ?? row.client_code} onClick={() => onSelect({
              rowKey: getClientRowKey(row.client_id || row.client_code, row.entity_code, row.month),
              clientCode: row.client_id || row.client_code,
              entityCode: row.entity_code,
              month: row.month
            }, "db")}>
              <td>{row.id ?? "-"}</td>
              <td>{row.client_id || row.client_code || "-"}</td>
              <td>{row.entity_code || "-"}</td>
              <td>{row.month || "-"}</td>
              <td>{row.status || "-"}</td>
            </tr>
          )) : <tr><td colSpan="5" className="py-8 text-center text-slate-500">No DB data available.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// Generic result renderer for /db/query responses.
function ResultTable({ rows, columns = [] }) {
  const visibleColumns = columns.length ? columns : (Array.isArray(rows) && rows[0] ? Object.keys(rows[0]) : []);

  if (!visibleColumns.length) {
    return <div className="rounded-md border border-slate-200 py-4 text-center text-sm text-slate-500">No rows returned.</div>;
  }

  return (
    <div className="max-h-80 overflow-auto rounded-md border border-slate-200">
      <table className="table min-w-[640px]">
        <thead>
          <tr>{visibleColumns.map((column) => <th key={column}>{formatColumnLabel(column)}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length ? rows.map((row, index) => (
            <tr key={index}>
              {visibleColumns.map((column) => <td key={column}>{row[column] ?? ""}</td>)}
            </tr>
          )) : (
            <tr>
              <td colSpan={visibleColumns.length} className="py-8 text-center text-slate-500">No rows returned.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// Shared modal shell for confirmations, uploads, and Config access.
function Modal({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[7vh]" role="dialog" aria-modal="true">
      <div className="w-full max-w-xl rounded-lg bg-white p-6 shadow-xl">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold text-slate-800">{title}</h2>
          <button className="btn btn-outline-secondary h-9 w-9 px-0" type="button" onClick={onClose} aria-label="Close modal">
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default App;
