import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { FixedSizeList as List } from "react-window";
import "./style.css";

const tabs = [
  { id: "live", label: "Live Run", icon: "activity" },
  { id: "sftp", label: "SFTP Portal", icon: "external" },
  { id: "clients", label: "Clients", icon: "users" },
  { id: "config", label: "Config", icon: "settings" }
];

const toolbarTabs = tabs.filter((tab) => ["live", "sftp"].includes(tab.id));

const defaultConfig = {
  sftpUrl: "https://example.com",
  dbUser: "",
  dbPass: ""
};

const emptyClientConfigForm = {
  id: "",
  client_name: "",
  client_code: "",
  entity_code: "",
  month: "",
  file_path: "",
  status: "Pending"
};

function getMonthYearOptions() {
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

function Icon({ name, className = "h-4 w-4" }) {
  const icons = {
    activity: (
      <path d="M22 12h-4l-3 8L9 4l-3 8H2" />
    ),
    upload: (
      <>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <path d="m17 8-5-5-5 5" />
        <path d="M12 3v12" />
      </>
    ),
    play: <path d="m5 3 14 9-14 9V3Z" />,
    stop: <path d="M6 6h12v12H6z" />,
    download: (
      <>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <path d="M7 10l5 5 5-5" />
        <path d="M12 15V3" />
      </>
    ),
    menu: (
      <>
        <path d="M4 6h16" />
        <path d="M4 12h16" />
        <path d="M4 18h16" />
      </>
    ),
    spreadsheet: (
      <>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
        <path d="M8 13h8" />
        <path d="M8 17h8" />
        <path d="M8 9h2" />
      </>
    ),
    external: (
      <>
        <path d="M15 3h6v6" />
        <path d="M10 14 21 3" />
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      </>
    ),
    history: (
      <>
        <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
        <path d="M3 3v5h5" />
        <path d="M12 7v5l4 2" />
      </>
    ),
    database: (
      <>
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5" />
        <path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3" />
      </>
    ),
    settings: (
      <>
        <path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.2a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.3a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.8v.5a2 2 0 0 1-1 1.7l-.2.1a2 2 0 0 0-.7 2.7l.2.3a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.2a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.2a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.3a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.5a2 2 0 0 1 1-1.8l.2-.1a2 2 0 0 0 .7-2.7l-.2-.3a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.2a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    search: <path d="m21 21-4.3-4.3M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z" />,
    check: (
      <>
        <path d="M22 11.1V12a10 10 0 1 1-5.9-9.1" />
        <path d="m22 4-10 10.01-3-3" />
      </>
    ),
    warning: (
      <>
        <path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </>
    ),
    hourglass: (
      <>
        <path d="M5 22h14" />
        <path d="M5 2h14" />
        <path d="M17 22v-4.2a4 4 0 0 0-1.2-2.8L12 12l-3.8 3A4 4 0 0 0 7 17.8V22" />
        <path d="M7 2v4.2A4 4 0 0 0 8.2 9L12 12l3.8-3A4 4 0 0 0 17 6.2V2" />
      </>
    ),
    list: (
      <>
        <path d="M8 6h13" />
        <path d="M8 12h13" />
        <path d="M8 18h13" />
        <path d="M3 6h.01" />
        <path d="M3 12h.01" />
        <path d="M3 18h.01" />
      </>
    ),
    users: (
      <>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.9" />
        <path d="M16 3.1a4 4 0 0 1 0 7.8" />
      </>
    ),
    plus: (
      <>
        <path d="M5 12h14" />
        <path d="M12 5v14" />
      </>
    ),
    save: (
      <>
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
        <path d="M17 21v-8H7v8" />
        <path d="M7 3v5h8" />
      </>
    ),
    trash: (
      <>
        <path d="M3 6h18" />
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        <path d="M19 6 18 20a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6" />
        <path d="M14 11v6" />
      </>
    ),
    repeat: (
      <>
        <path d="m17 2 4 4-4 4" />
        <path d="M3 11V9a4 4 0 0 1 4-4h14" />
        <path d="m7 22-4-4 4-4" />
        <path d="M21 13v2a4 4 0 0 1-4 4H3" />
      </>
    ),
    arrowRight: <path d="M5 12h14M13 5l7 7-7 7" />,
    x: (
      <>
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </>
    ),
    circle: <circle cx="12" cy="12" r="10" />
  };

  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {icons[name] || icons.circle}
    </svg>
  );
}

function emptyClient(clientCode, defaults = {}) {
  return {
    clientCode,
    clientName: defaults.clientName || defaults.client_name || defaults.name || clientCode,
    entityCode: defaults.entityCode || "-",
    month: defaults.month || "-",
    filePath: defaults.filePath || "-",
    createdAt: defaults.createdAt || "-",
    rawStatus: defaults.rawStatus || "Pending",
    downloadStatus: defaults.downloadStatus || "PENDING",
    uploadStatus: defaults.uploadStatus || "PENDING"
  };
}

function normalizeEvent(data, previous) {
  if (!data.client) return previous;
  const current = previous[data.client] || emptyClient(data.client, {
    clientName: data.clientName || data.client_name || data.name,
    entityCode: data.entity || "-",
    month: data.month || "-"
  });
  const next = { ...current };

  if (data.type === "START") {
    next.downloadStatus = "PROCESSING";
    next.uploadStatus = next.uploadStatus || "PENDING";
  } else if (data.type === "SUCCESS") {
    next.downloadStatus = "SUCCESS";
    next.filePath = data.filePath || next.filePath;
    if (next.uploadStatus === "PENDING") next.uploadStatus = "PROCESSING";
  } else if (data.type === "FAILED") {
    next.downloadStatus = "FAILED";
  } else if (data.type === "UPLOADED") {
    next.uploadStatus = "SUCCESS";
  } else if (data.type === "UPLOAD_FAILED") {
    next.uploadStatus = "FAILED";
  }

  return { ...previous, [data.client]: next };
}

function formatLogMessage(data) {
  if (data.type === "START") return `Started processing ${data.client}`;
  if (data.type === "SUCCESS") return `Download completed for ${data.client}`;
  if (data.type === "FAILED") return `Download failed for ${data.client}`;
  if (data.type === "UPLOADED") return `Uploaded to destination for ${data.client}`;
  if (data.type === "UPLOAD_FAILED") return `Upload failed for ${data.client}`;
  return "Event received";
}

function App() {
  const [clients, setClients] = useState({});
  const [dbRecords, setDbRecords] = useState([]);
  const [activeTab, setActiveTab] = useState("live");
  const [search, setSearch] = useState("");
  const [liveFilter, setLiveFilter] = useState("all");
  const [logs, setLogs] = useState([]);
  const [currentClient, setCurrentClient] = useState("-");
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [isNavOpen, setIsNavOpen] = useState(false);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [isStartConfirmOpen, setIsStartConfirmOpen] = useState(false);
  const [isStopConfirmOpen, setIsStopConfirmOpen] = useState(false);
  const [isAutomationRunning, setIsAutomationRunning] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [isDbAuthOpen, setIsDbAuthOpen] = useState(false);
  const [dbAuth, setDbAuth] = useState({ user: "", pass: "" });
  const [dbAuthError, setDbAuthError] = useState("");
  const [config, setConfig] = useState(defaultConfig);
  const [configStatus, setConfigStatus] = useState("");
  const [historyMonth, setHistoryMonth] = useState("");
  const [historyYear, setHistoryYear] = useState("");
  const [selectedMonthYear, setSelectedMonthYear] = useState(() => getMonthYearOptions()[1].value);
  const [isMonthMenuOpen, setIsMonthMenuOpen] = useState(false);
  const [sqlQuery, setSqlQuery] = useState("");
  const [dbResultRows, setDbResultRows] = useState([]);
  const [clientConfigSearch, setClientConfigSearch] = useState("");
  const [clientConfigForm, setClientConfigForm] = useState(emptyClientConfigForm);
  const [clientConfigStatus, setClientConfigStatus] = useState("");
  const [configSection, setConfigSection] = useState("clientConfig");
  const queryAbortRef = useRef(null);
  const fileInputRef = useRef(null);

  const addLog = (message) => {
    setLogs((items) => [`${new Date().toLocaleTimeString()} - ${message}`, ...items].slice(0, 200));
  };

  const loadDbData = async () => {
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

  const hydrateLiveFromDb = (rows) => {
    if (!rows.length) return;
    setClients((previous) => {
      const next = { ...previous };
      rows.forEach((row) => {
        if (!row.client_code) return;
        const record = next[row.client_code] || emptyClient(row.client_code, {
          clientName: row.client_name || row.clientName || row.name,
          entityCode: row.entity_code,
          month: row.month,
          filePath: row.file_path,
          createdAt: row.created_at,
          rawStatus: row.status
        });
        const dbStatus = String(row.status || "").toUpperCase();
        next[row.client_code] = {
          ...record,
          downloadStatus: dbStatus.includes("FAIL") ? "FAILED" : dbStatus.includes("SUCCESS") ? "SUCCESS" : record.downloadStatus,
          uploadStatus: dbStatus.includes("SUCCESS") ? "SUCCESS" : record.uploadStatus
        };
      });
      return next;
    });
  };

  useEffect(() => {
    loadDbData().then(hydrateLiveFromDb);
  }, []);

  useEffect(() => {
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
        if (data?.client && data.type === "START") setCurrentClient(data.client);
        setClients((previous) => normalizeEvent(data, previous));
        addLog(formatLogMessage(data));
      };
    } catch {
      addLog("Live log stream is unavailable.");
    }
    return () => source?.close();
  }, []);

  const clientRows = useMemo(() => Object.values(clients), [clients]);
  const stats = useMemo(() => {
    const total = clientRows.length;
    const success = clientRows.filter((r) => r.downloadStatus === "SUCCESS" && r.uploadStatus === "SUCCESS").length;
    const failed = clientRows.filter((r) => r.downloadStatus === "FAILED" || r.uploadStatus === "FAILED").length;
    const processing = clientRows.filter((r) => r.downloadStatus === "PROCESSING" || r.uploadStatus === "PROCESSING").length;
    return { total, success, failed, processing, completed: success + failed };
  }, [clientRows]);
  const progressPercent = stats.total === 0 ? 0 : Math.round((stats.completed / stats.total) * 100);

  const filteredLiveRows = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return clientRows.filter((item) => {
      const isFailed = item.downloadStatus === "FAILED" || item.uploadStatus === "FAILED";
      const isProcessed = !["PENDING", "PROCESSING"].includes(item.downloadStatus) && !["PENDING", "PROCESSING"].includes(item.uploadStatus);
      if (liveFilter === "failed" && !isFailed) return false;
      if (liveFilter === "processed" && !isProcessed) return false;
      if (!keyword) return true;
      return `${item.clientCode} ${item.clientName} ${item.entityCode} ${item.month} ${item.downloadStatus} ${item.uploadStatus}`.toLowerCase().includes(keyword);
    });
  }, [clientRows, liveFilter, search]);

  const filteredDbRows = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return dbRecords.filter((item) => {
      if (!keyword) return true;
      return `${item.client_code || ""} ${item.entity_code || ""} ${item.month || ""} ${item.status || ""}`.toLowerCase().includes(keyword);
    });
  }, [dbRecords, search]);

  const months = useMemo(() => Array.from(new Set(dbRecords.map((row) => row.month).filter(Boolean))).sort(), [dbRecords]);
  const years = useMemo(() => {
    const values = new Set();
    dbRecords.forEach((row) => {
      const match = String(row.month || "").match(/\d{4}/);
      if (match) values.add(match[0]);
    });
    return Array.from(values).sort();
  }, [dbRecords]);

  const historyRows = useMemo(() => {
    return dbRecords.filter((row) => {
      const value = String(row.month || "");
      if (historyMonth && value !== historyMonth) return false;
      if (historyYear && !value.includes(historyYear)) return false;
      return true;
    });
  }, [dbRecords, historyMonth, historyYear]);
  const showDashboardSummary = toolbarTabs.some((tab) => tab.id === activeTab);

  const filteredClientConfigRows = useMemo(() => {
    const keyword = clientConfigSearch.trim().toLowerCase();
    return dbRecords.filter((row) => {
      if (!keyword) return true;
      return `${row.client_name || ""} ${row.client_code || ""} ${row.entity_code || ""} ${row.file_path || ""}`.toLowerCase().includes(keyword);
    });
  }, [clientConfigSearch, dbRecords]);

  const selectTab = (tabId) => {
    if (tabId === "config") {
      setIsDbAuthOpen(true);
      setDbAuthError("");
      return;
    }
    setActiveTab(tabId);
    setIsNavOpen(false);
    if (tabId === "sftp") openSftpPortal();
    if (tabId === "clients") refreshClientConfig();
  };

  const openSftpPortal = () => {
    const url = (config.sftpUrl || "").trim();
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  const startAutomation = async () => {
    addLog("Starting automation...");
    try {
      const response = await fetch("/start", { method: "POST" }).catch(() => fetch("/start"));
      if (!response?.ok) addLog("Could not start automation.");
      else {
        setIsStartConfirmOpen(false);
        setIsAutomationRunning(true);
        addLog("Automation started.");
      }
    } catch {
      addLog("Could not start automation.");
    }
  };

  const stopAutomation = async () => {
    await fetch("/stop", { method: "POST" }).catch(() => fetch("/stop"));
    setIsStopConfirmOpen(false);
    setIsAutomationRunning(false);
    addLog("Stop requested by user.");
  };

  const resetDashboard = () => {
    setClients({});
    setLogs([]);
    setCurrentClient("-");
    setSelectedRecord(null);
  };

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

    try {
      const res = await fetch("/upload", { method: "POST", body: formData });
      if (!res.ok) {
        setUploadError("Upload failed.");
        return;
      }
      setIsUploadOpen(false);
      setUploadError("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      addLog(`Client file uploaded: ${file.name}`);
      resetDashboard();
      const rows = await loadDbData();
      hydrateLiveFromDb(rows);
    } catch {
      setUploadError("Server error during upload.");
    }
  };

  const retryAction = async (type, clientCode) => {
    const endpoint = type === "download" ? "/retry/download" : "/retry/upload";
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientCode })
      });
      if (!res.ok) throw new Error("Retry endpoint error");
      addLog(`Retry requested for ${type} - ${clientCode}`);
      setClients((previous) => ({
        ...previous,
        [clientCode]: {
          ...previous[clientCode],
          [type === "download" ? "downloadStatus" : "uploadStatus"]: "PROCESSING"
        }
      }));
    } catch {
      addLog(`Retry API not available for ${type} (${clientCode}). Add ${endpoint} in server.`);
    }
  };

  const showRecordDetails = (clientCode, source) => {
    const live = clients[clientCode];
    const db = dbRecords.find((record) => record.client_code === clientCode);
    setSelectedRecord({
      clientCode,
      entityCode: live?.entityCode || db?.entity_code || "-",
      month: live?.month || db?.month || "-",
      downloadStatus: live?.downloadStatus || "-",
      uploadStatus: live?.uploadStatus || "-",
      dbStatus: db?.status || live?.rawStatus || "-",
      filePath: db?.file_path || live?.filePath || "-",
      createdAt: db?.created_at || live?.createdAt || "-",
      source
    });
  };

  const executeSql = async () => {
    const query = sqlQuery.trim();
    if (!query) {
      setDbResultRows([]);
      return;
    }
    queryAbortRef.current = new AbortController();
    try {
      const res = await fetch("/db/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: queryAbortRef.current.signal
      });
      if (!res.ok) throw new Error("Query API unavailable");
      const data = await res.json();
      setDbResultRows(Array.isArray(data.rows) ? data.rows : []);
    } catch {
      setDbResultRows(dbRecords.slice(0, 100));
    }
  };

  const listTables = async () => {
    try {
      const res = await fetch("/db/tables");
      if (!res.ok) throw new Error("Tables API unavailable");
      const data = await res.json();
      setDbResultRows((data.tables || []).map((name) => ({ table_name: name })));
    } catch {
      setDbResultRows([{ table_name: "clients" }]);
    }
  };

  const stopSql = () => {
    queryAbortRef.current?.abort();
    queryAbortRef.current = null;
  };

  const loginDb = () => {
    if (!dbAuth.user.trim() || !dbAuth.pass.trim()) {
      setDbAuthError("Username and password required.");
      return;
    }
    setConfig((value) => ({ ...value, dbUser: dbAuth.user.trim(), dbPass: dbAuth.pass.trim() }));
    setIsDbAuthOpen(false);
    setIsNavOpen(false);
    setActiveTab("config");
    refreshClientConfig();
  };

  const refreshClientConfig = async (message = "") => {
    const rows = await loadDbData();
    if (message) setClientConfigStatus(message);
    return rows;
  };

  const selectClientConfigRow = (row) => {
    setClientConfigForm({
      id: row.id ?? "",
      client_name: row.client_name || "",
      client_code: row.client_code || "",
      entity_code: row.entity_code || "",
      month: row.month || "",
      file_path: row.file_path || "",
      status: row.status || "Pending"
    });
    setClientConfigStatus("Client selected for editing.");
  };

  const clearClientConfigForm = () => {
    setClientConfigForm(emptyClientConfigForm);
    setClientConfigStatus("");
  };

  const addClientConfig = async () => {
    if (!clientConfigForm.client_code.trim()) {
      setClientConfigStatus("Client code is required.");
      return;
    }
    try {
      const res = await fetch("/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(clientConfigForm)
      });
      if (!res.ok) throw new Error("Add failed");
      clearClientConfigForm();
      await refreshClientConfig("Client added.");
    } catch {
      setClientConfigStatus("Could not add client.");
    }
  };

  const updateClientConfig = async () => {
    if (!clientConfigForm.id || !clientConfigForm.client_code.trim()) {
      setClientConfigStatus("Select a client row and keep client code filled.");
      return;
    }
    try {
      const res = await fetch(`/clients/${clientConfigForm.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(clientConfigForm)
      });
      if (!res.ok) throw new Error("Update failed");
      await refreshClientConfig("Client updated.");
    } catch {
      setClientConfigStatus("Could not update client.");
    }
  };

  const deleteClientConfig = async () => {
    if (!clientConfigForm.id) {
      setClientConfigStatus("Select a client row to delete.");
      return;
    }
    if (!window.confirm("Delete this client?")) return;
    try {
      const res = await fetch(`/clients/${clientConfigForm.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      clearClientConfigForm();
      await refreshClientConfig("Client deleted.");
    } catch {
      setClientConfigStatus("Could not delete client.");
    }
  };

  return (
    <div className="min-h-screen bg-slate-100">
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
          {tabs.map((tab) => (
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
      {isNavOpen && <button className="fixed inset-0 z-30 bg-blue-950/25" aria-label="Close navigation" onClick={() => setIsNavOpen(false)} />}

      <main className="min-w-0">
        <header className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b border-[#00152b] bg-[#001f3f] px-5 py-4">
          <div className="flex items-center gap-2">
            <button className="btn btn-outline-light h-10 w-10 px-0" type="button" onClick={() => setIsNavOpen(true)} aria-label="Open navigation">
              <Icon name="menu" />
            </button>
            <div>
              <h2 className="m-0 text-lg font-semibold text-white">Operations Dashboard</h2>
              <p className="m-0 text-sm text-blue-100">Track download and upload pipeline in real time</p>
            </div>
          </div>
          {showDashboardSummary && <div className="flex flex-wrap gap-2">
            <button className="btn btn-outline-light" type="button" onClick={() => setIsUploadOpen(true)}>
              <Icon name="upload" />Upload Excel
            </button>
            <MonthDropdown
              value={selectedMonthYear}
              onChange={setSelectedMonthYear}
              isOpen={isMonthMenuOpen}
              setIsOpen={setIsMonthMenuOpen}
            />
            <button className="btn btn-success" type="button" disabled={isAutomationRunning} onClick={() => setIsStartConfirmOpen(true)}>
              <Icon name="play" />{isAutomationRunning ? "Running" : "Start"}
            </button>
            <button className="btn btn-danger" type="button" onClick={() => setIsStopConfirmOpen(true)}>
              <Icon name="stop" />Stop
            </button>
            <button className="btn btn-outline-light" type="button" onClick={() => addLog("Download paysheets action is not connected to an API yet.")}>
              <Icon name="download" />Download Paysheets
            </button>
          </div>}
        </header>

        <div className={`grid gap-4 p-5 ${activeTab === "live" ? "lg:grid-cols-[minmax(0,1fr)_260px]" : "lg:grid-cols-1"}`}>
          {showDashboardSummary && <section className="panel grid gap-5 px-5 py-4 md:grid-cols-[minmax(420px,auto)_minmax(300px,1fr)] md:items-center">
            <div className="flex min-w-0 items-center">
              <div className="flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#001f3f] text-xs font-bold text-white">1</span>
                <div>
                  <strong className="block text-sm text-[#001f3f]">Download</strong>
                  
                </div>
              </div>
              <div className="mx-4 h-px w-16 bg-blue-200 md:w-24" />
              <div className="flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#e8f0fb] text-xs font-bold text-[#001f3f]">2</span>
                <div>
                  <strong className="block text-sm text-slate-700">Upload</strong>
                  
                </div>
              </div>
            </div>
            <div className="w-full md:max-w-2xl md:justify-self-end">
              <div className="mb-1 flex items-center justify-between gap-3 text-xs font-semibold text-slate-500">
                <span className="inline-flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-[#001f3f]" />
                  Progress
                </span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">{stats.completed}/{stats.total} completed</span>
              </div>
              <div className="h-4 overflow-hidden rounded-full bg-slate-200">
                <div className="h-full rounded-full bg-blue-600 text-center text-[11px] font-semibold leading-4 text-white transition-all" style={{ width: `${progressPercent}%` }}>
                  {progressPercent}%
                </div>
              </div>
              <div className="mt-1 flex items-center justify-between gap-3 text-xs text-slate-500">
                <span>Current client: {currentClient}</span>
                <span>{stats.processing > 0 ? "Running" : "To start the automation"}</span>
              </div>
            </div>
          </section>}

          {activeTab === "live" && <aside className="panel row-span-6 p-4 lg:col-start-2 lg:row-start-1">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-500">Details</h3>
            </div>
            <Details record={selectedRecord} />
          </aside>}

          {showDashboardSummary && <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Metric label="Total" value={stats.total} icon="list" tone="border-[#001f3f]" />
            <Metric label="Processing" value={stats.processing} icon="hourglass" tone="border-amber-500" />
            <Metric label="Success" value={stats.success} icon="check" tone="border-emerald-500" />
            <Metric label="Failed" value={stats.failed} icon="warning" tone="border-red-500" />
          </section>}

          {showDashboardSummary && <section className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-wrap gap-2">
              {toolbarTabs.map((tab) => (
                <button key={tab.id} className={`btn btn-sm ${activeTab === tab.id ? "btn-primary" : "btn-outline-primary"}`} type="button" onClick={() => selectTab(tab.id)}>
                  <Icon name={tab.icon} />{tab.label}
                </button>
              ))}
            </div>
            <div className="flex w-full flex-col gap-2 md:max-w-xl md:flex-row">
              <label className="relative block flex-1">
                <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input className="field pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by client, entity, month, or status" />
              </label>
            </div>
          </section>}

          {activeTab === "live" && <LiveTab rows={filteredLiveRows} liveFilter={liveFilter} setLiveFilter={setLiveFilter} onRetry={retryAction} onSelect={showRecordDetails} />}
          {activeTab === "sftp" && <SftpTab onOpen={openSftpPortal} />}
          {activeTab === "clients" && (
            <ClientsTab
              rows={filteredClientConfigRows}
              search={clientConfigSearch}
              setSearch={setClientConfigSearch}
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
                onClear: clearClientConfigForm
              }}
              dbProps={{
                sqlQuery,
                setSqlQuery,
                rows: dbResultRows,
                onExecute: executeSql,
                onStop: stopSql,
                onListTables: listTables
              }}
              logs={logs}
              selectedMonthYear={selectedMonthYear}
              setSelectedMonthYear={setSelectedMonthYear}
            />
          )}
        </div>
      </main>

      {isUploadOpen && (
        <Modal title="Upload Client File" onClose={() => setIsUploadOpen(false)}>
          <p className="mb-3 text-sm text-slate-500">Use Excel or CSV file with client/entity/month data.</p>
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

      {isDbAuthOpen && (
        <Modal title="Config Access Required" onClose={() => setIsDbAuthOpen(false)}>
          <p className="mb-3 text-sm text-slate-500">Enter username and password to open Config.</p>
          <div className="space-y-2">
            <input className="field" value={dbAuth.user} onChange={(event) => setDbAuth((value) => ({ ...value, user: event.target.value }))} placeholder="Username" />
            <input className="field" type="password" value={dbAuth.pass} onChange={(event) => setDbAuth((value) => ({ ...value, pass: event.target.value }))} placeholder="Password" />
          </div>
          <div className="mt-4 flex justify-between gap-2">
            <button className="btn btn-primary" type="button" onClick={loginDb}>Login</button>
            <button className="btn btn-outline-secondary" type="button" onClick={() => setIsDbAuthOpen(false)}>Cancel</button>
          </div>
          {dbAuthError && <p className="mt-2 text-sm text-red-600">{dbAuthError}</p>}
        </Modal>
      )}

      <div className="hidden">{logs.map((line) => <div key={line}>{line}</div>)}</div>
    </div>
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

function Metric({ label, value, icon, tone }) {
  return (
    <div className={`panel min-h-[92px] border-l-4 ${tone} px-4 py-3`}>
      <div className="flex items-center justify-between gap-3 text-sm font-medium text-slate-500">
        <span>{label}</span>
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-slate-100 text-slate-600">
          <Icon name={icon} className="h-4 w-4" />
        </span>
      </div>
      <div className="mt-2 text-2xl font-semibold leading-none text-slate-900">{value}</div>
    </div>
  );
}

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

function LiveVirtualRow({ index, style, data }) {
  const { rows, onRetry, onSelect } = data;
  const item = rows[index];

  return (
    <div
      className="grid cursor-pointer grid-cols-[13%_17%_14%_12%_16%_16%_12%] items-center border-t border-slate-100 px-3 text-sm text-slate-700 hover:bg-[#f7faff]"
      style={style}
      onClick={() => onSelect(item.clientCode, "live")}
    >
      <div className="truncate px-1">{item.clientCode}</div>
      <div className="truncate px-1">{item.clientName || item.clientCode}</div>
      <div className="truncate px-1">{item.entityCode}</div>
      <div className="truncate px-1">{item.month}</div>
      <div className="px-1"><StatusChip status={item.downloadStatus} /></div>
      <div className="px-1"><StatusChip status={item.uploadStatus} /></div>
      <div className="flex min-h-8 items-center justify-center gap-1 px-1">
        {item.downloadStatus === "FAILED" && (
          <button className="btn btn-sm btn-outline-warning text-amber-700" onClick={(event) => { event.stopPropagation(); onRetry("download", item.clientCode); }}>
            <Icon name="repeat" />Retry Download
          </button>
        )}
        {item.uploadStatus === "FAILED" && (
          <button className="btn btn-sm btn-outline-warning text-amber-700" onClick={(event) => { event.stopPropagation(); onRetry("upload", item.clientCode); }}>
            <Icon name="repeat" />Retry Upload
          </button>
        )}
      </div>
    </div>
  );
}

function LiveTab({ rows, liveFilter, setLiveFilter, onRetry, onSelect }) {
  const listHeight = Math.min(Math.max(rows.length, 1) * 56, 420);

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
        <div className="min-w-[960px]">
          <div className="grid grid-cols-[13%_17%_14%_12%_16%_16%_12%] bg-[#f7faff] px-3 py-3 text-xs font-semibold uppercase tracking-normal text-[#49627d]">
            <div className="px-1">Client ID</div>
            <div className="px-1">Client Name</div>
            <div className="px-1">Entity Code</div>
            <div className="px-1">Month</div>
            <div className="px-1">Download Status</div>
            <div className="px-1">Upload Status</div>
            <div className="px-1 text-center">Actions</div>
          </div>
          {rows.length ? (
            <List
              height={listHeight}
              itemCount={rows.length}
              itemData={{ rows, onRetry, onSelect }}
              itemKey={(index, data) => data.rows[index].clientCode}
              itemSize={56}
              width="100%"
            >
              {LiveVirtualRow}
            </List>
          ) : (
            <div className="border-t border-slate-100 py-8 text-center text-sm text-slate-500">Start the automation</div>
          )}
        </div>
      </div>
    </section>
  );
}

function SftpTab({ onOpen }) {
  return (
    <section className="panel p-4">
      <h3 className="mb-2 text-sm font-semibold text-slate-500">SFTP Portal</h3>
      <p className="mb-3 text-sm text-slate-500">Open the SFTP website in a new tab.</p>
      <button className="btn btn-primary btn-sm" type="button" onClick={onOpen}><Icon name="external" />Open SFTP Portal</button>
    </section>
  );
}

function HistoryTab({ rows, months, years, month, year, setMonth, setYear }) {
  return (
    <section className="panel p-4">
      <div className="mb-3 grid gap-2 md:grid-cols-[1fr_1fr_auto] md:items-end">
        <label className="block text-sm text-slate-500">
          Month
          <select className="field mt-1" value={month} onChange={(event) => setMonth(event.target.value)}>
            <option value="">All Months</option>
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
        <button className="btn btn-outline-primary btn-sm" type="button">Show History</button>
      </div>
      <div className="space-y-2 text-sm text-slate-500">
        {rows.length ? rows.map((row) => (
          <div key={`${row.id}-${row.client_code}`} className="border-b border-dashed border-slate-200 py-2">
            <strong>{row.client_code || "-"}</strong> | Entity: {row.entity_code || "-"} | Month: {row.month || "-"} | Status: {row.status || "-"}
          </div>
        )) : <span>No history found for selected month/year.</span>}
      </div>
    </section>
  );
}

function DbTab({ sqlQuery, setSqlQuery, rows, onExecute, onStop, onListTables }) {
  return (
    <section className="panel p-4">
      <h3 className="mb-2 text-sm font-semibold text-slate-500">Database Query Console</h3>
      <textarea className="field min-h-32 font-mono text-sm" value={sqlQuery} onChange={(event) => setSqlQuery(event.target.value)} placeholder="Write SQL query here..." />
      <div className="my-3 flex flex-wrap gap-2">
        <button className="btn btn-primary btn-sm" type="button" onClick={onExecute}>Execute</button>
        <button className="btn btn-outline-danger btn-sm" type="button" onClick={onStop}>Stop</button>
        <button className="btn btn-outline-secondary btn-sm" type="button" onClick={onListTables}>List Tables</button>
      </div>
      <ResultTable rows={rows} />
    </section>
  );
}

function ConfigHub({ activeSection, setActiveSection, clientConfigProps, dbProps, logs, selectedMonthYear, setSelectedMonthYear }) {
  const sections = [
    { id: "clientConfig", label: "Client Configuration", icon: "users" },
    { id: "db", label: "DB", icon: "database" },
    { id: "log", label: "Log", icon: "list" }
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
      {activeSection === "log" && <LogTab logs={logs} selectedMonthYear={selectedMonthYear} setSelectedMonthYear={setSelectedMonthYear} />}
    </section>
  );
}

function downloadLogsCsv(logs, selectedMonthYear) {
  const escapeCsv = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const rows = [
    ["Month", "Timestamp", "Message"],
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

function LogTab({ logs, selectedMonthYear, setSelectedMonthYear }) {
  return (
    <section className="panel p-4">
      <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <h3 className="text-base font-semibold text-slate-800">Automation Log</h3>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <select className="field font-semibold uppercase sm:w-44" value={selectedMonthYear} onChange={(event) => setSelectedMonthYear(event.target.value)} aria-label="Log month and year">
            {getMonthYearOptions().map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <button className="btn btn-primary" type="button" onClick={() => downloadLogsCsv(logs, selectedMonthYear)}>
            <Icon name="download" />Download CSV
          </button>
        </div>
      </div>
      <div className="max-h-[calc(100vh-220px)] overflow-auto rounded-md border border-slate-200 bg-slate-950 p-3 font-mono text-sm text-slate-100">
        {logs.length ? logs.map((line) => (
          <div key={line} className="border-b border-white/10 py-1 last:border-b-0">{line}</div>
        )) : <div className="text-slate-400">No logs available.</div>}
      </div>
    </section>
  );
}

function ClientsVirtualRow({ index, style, data }) {
  const row = data.rows[index];

  return (
    <div
      className="grid grid-cols-[22%_18%_18%_28%_14%] items-center border-t border-slate-100 px-4 text-sm text-slate-700 hover:bg-[#f7faff]"
      style={style}
    >
      <div className="truncate px-1">{row.client_name || "-"}</div>
      <div className="truncate px-1">{row.client_code || "-"}</div>
      <div className="truncate px-1">{row.entity_code || "-"}</div>
      <div className="truncate px-1" title={row.file_path || ""}>{row.file_path || "-"}</div>
      <div className="truncate px-1">{row.status || "-"}</div>
    </div>
  );
}

function ClientsTab({ rows, search, setSearch }) {
  const listHeight = Math.min(rows.length * 52, 560);

  return (
    <section className="panel flex max-h-[calc(100vh-170px)] flex-col overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-slate-200 p-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h3 className="text-base font-semibold text-slate-800">Clients</h3>
          <p className="text-sm text-slate-500">Loaded client list from database</p>
        </div>
        <label className="relative block w-full md:max-w-md">
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input className="field pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search client, code, entity, or path" />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-x-auto">
        <div className="min-w-[860px]">
          <div className="grid grid-cols-[22%_18%_18%_28%_14%] bg-[#f7faff] px-4 py-3 text-xs font-semibold uppercase tracking-normal text-[#49627d]">
            <div className="px-1">Client Name</div>
            <div className="px-1">Client ID</div>
            <div className="px-1">Entity Code</div>
            <div className="px-1">Path</div>
            <div className="px-1">Status</div>
          </div>
          {rows.length ? (
            <List
              height={listHeight}
              itemCount={rows.length}
              itemData={{ rows }}
              itemKey={(index, data) => data.rows[index].id ?? data.rows[index].client_code ?? index}
              itemSize={52}
              width="100%"
            >
              {ClientsVirtualRow}
            </List>
          ) : (
            <div className="border-t border-slate-100 py-8 text-center text-sm text-slate-500">No clients loaded.</div>
          )}
        </div>
      </div>
    </section>
  );
}

function ClientConfigVirtualRow({ index, style, data }) {
  const { rows, selectedId, onSelect } = data;
  const row = rows[index];
  const isSelected = String(selectedId) === String(row.id);

  return (
    <div
      className={`grid cursor-pointer grid-cols-[22%_18%_18%_28%_14%] items-center border-t border-slate-100 px-4 text-sm text-slate-700 ${isSelected ? "bg-blue-50" : "hover:bg-[#f7faff]"}`}
      style={style}
      onClick={() => onSelect(row)}
    >
      <div className="truncate px-1">{row.client_name || "-"}</div>
      <div className="truncate px-1">{row.client_code || "-"}</div>
      <div className="truncate px-1">{row.entity_code || "-"}</div>
      <div className="truncate px-1" title={row.file_path || ""}>{row.file_path || "-"}</div>
      <div className="truncate px-1">{row.status || "-"}</div>
    </div>
  );
}

function ClientConfigurationTab({ rows, search, setSearch, form, setForm, status, onSelect, onAdd, onUpdate, onDelete, onClear }) {
  const listHeight = Math.min(rows.length * 52, 560);
  const updateField = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="panel flex max-h-[calc(100vh-150px)] flex-col overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-200 p-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-800">Client Configuration</h3>
            <p className="text-sm text-slate-500">Database clients list</p>
          </div>
          <label className="relative block w-full md:max-w-sm">
            <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input className="field pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search client, code, entity, or path" />
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-x-auto">
          <div className="min-w-[960px]">
            <div className="grid grid-cols-[22%_18%_18%_28%_14%] bg-[#f7faff] px-4 py-3 text-xs font-semibold uppercase tracking-normal text-[#49627d]">
              <div className="px-1">Client Name</div>
              <div className="px-1">Client Code</div>
              <div className="px-1">Entity Code</div>
              <div className="px-1">Path</div>
              <div className="px-1">Status</div>
            </div>
            {rows.length ? (
              <List
                height={listHeight}
                itemCount={rows.length}
                itemData={{ rows, selectedId: form.id, onSelect }}
                itemKey={(index, data) => data.rows[index].id ?? data.rows[index].client_code ?? index}
                itemSize={52}
                width="100%"
              >
                {ClientConfigVirtualRow}
              </List>
            ) : (
              <div className="border-t border-slate-100 py-8 text-center text-sm text-slate-500">No clients found.</div>
            )}
          </div>
        </div>
      </div>

      <div className="panel p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-800">{form.id ? "Edit Client" : "Add Client"}</h3>
          <button className="btn btn-outline-secondary btn-sm" type="button" onClick={onClear}>Clear</button>
        </div>

        <div className="space-y-3">
          <label className="block text-sm text-slate-500">
            Client Name
            <input className="field mt-1" value={form.client_name} onChange={(event) => updateField("client_name", event.target.value)} placeholder="Client name" />
          </label>
          <label className="block text-sm text-slate-500">
            Client Code
            <input className="field mt-1" value={form.client_code} onChange={(event) => updateField("client_code", event.target.value)} placeholder="Client code" />
          </label>
          <label className="block text-sm text-slate-500">
            Entity Code
            <input className="field mt-1" value={form.entity_code} onChange={(event) => updateField("entity_code", event.target.value)} placeholder="Entity code" />
          </label>
          <label className="block text-sm text-slate-500">
            Path
            <input className="field mt-1" value={form.file_path} onChange={(event) => updateField("file_path", event.target.value)} placeholder="File or folder path" />
          </label>
        </div>

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
function ConfigTab({ config, setConfig, status, setStatus }) {
  const save = () => setStatus("Configuration saved.");
  return (
    <section className="panel p-4">
      <h3 className="mb-2 text-sm font-semibold text-slate-500">Configuration</h3>
      <div className="space-y-2">
        <label className="block text-sm text-slate-500">SFTP Portal URL<input className="field mt-1" value={config.sftpUrl} onChange={(event) => setConfig((value) => ({ ...value, sftpUrl: event.target.value }))} /></label>
        <label className="block text-sm text-slate-500">DB Username<input className="field mt-1" value={config.dbUser} onChange={(event) => setConfig((value) => ({ ...value, dbUser: event.target.value }))} placeholder="Enter DB username" /></label>
        <label className="block text-sm text-slate-500">DB Password<input className="field mt-1" type="password" value={config.dbPass} onChange={(event) => setConfig((value) => ({ ...value, dbPass: event.target.value }))} placeholder="Enter DB password" /></label>
      </div>
      <button className="btn btn-outline-primary btn-sm mt-3" type="button" onClick={save}>Save Config</button>
      {status && <div className="mt-2 text-sm text-slate-500">{status}</div>}
    </section>
  );
}

function Details({ record }) {
  if (!record) return <div className="text-sm text-slate-500">Click any row in Live Run to view complete details.</div>;
  return (
    <div className="text-sm text-slate-500">
      {[
        ["Client Name", record.clientCode],
        ["Entity Code", record.entityCode],
        ["Month", record.month],
        ["Download Status", record.downloadStatus],
        ["Upload Status", record.uploadStatus],
        ["DB Status", record.dbStatus],
        ["File Path", record.filePath],
        ["Created At", record.createdAt]
      ].map(([label, value]) => (
        <div key={label} className="border-b border-dashed border-slate-200 py-2 last:border-b-0">
          <strong>{label}:</strong> {value}
        </div>
      ))}
    </div>
  );
}

function DbSideTable({ rows, onSelect }) {
  return (
    <div className="max-h-[420px] overflow-auto">
      <table className="table min-w-[420px] text-xs">
        <thead>
          <tr>
            <th>ID</th>
            <th>Client</th>
            <th>Entity</th>
            <th>Month</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? rows.map((row) => (
            <tr key={row.id ?? row.client_code} onClick={() => onSelect(row.client_code, "db")}>
              <td>{row.id ?? "-"}</td>
              <td>{row.client_code || "-"}</td>
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

function ResultTable({ rows }) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return <div className="rounded-md border border-slate-200 py-4 text-center text-sm text-slate-500">No rows returned.</div>;
  }
  const columns = Object.keys(rows[0]);
  return (
    <div className="max-h-80 overflow-auto rounded-md border border-slate-200">
      <table className="table min-w-[640px]">
        <thead>
          <tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => <td key={column}>{row[column] ?? ""}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[7vh]" role="dialog" aria-modal="true">
      <div className="w-full max-w-xl rounded-lg bg-white p-6 shadow-xl">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold text-slate-800">{title}</h2>
          <button className="btn btn-outline-secondary h-9 w-9 px-0" type="button" onClick={onClose} aria-label="Close modal"><Icon name="x" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);




















