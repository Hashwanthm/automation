// Shared UI configuration.
// Centralizing tab metadata and default form state keeps App.jsx focused on behavior.
export const tabs = [
  { id: "live", label: "Live Run", icon: "activity" },
  { id: "history", label: "History", icon: "history" },
  { id: "sftp", label: "SFTP Portal", icon: "external" },
  { id: "clients", label: "Companies", icon: "users" },
  { id: "stopProcess", label: "Stop Process", icon: "stop" },
  { id: "users", label: "Users", icon: "users" },
  { id: "config", label: "Config", icon: "settings" }
];

export const toolbarTabs = tabs.filter((tab) => ["live", "sftp"].includes(tab.id));

// Defaults used until persisted backend settings are loaded.
export const defaultConfig = {
  sftpUrl: "https://example.com",
  sftpUser: "",
  sftpPass: "",
  dbUser: "",
  dbPass: "",
  vistaHeadless: false,
  sftpHeadless: false
};

// Single source of truth for an empty row in the Client Configuration form.
export const emptyClientConfigForm = {
  id: "",
  client_group_key: "",
  client_id: "",
  client_name: "",
  client_code: "",
  has_entities: false,
  entity_code: "",
  month: "",
  sftp_path: "",
  file_path: "",
  status: "Pending",
  entityTab: "company",
  entities: [
    { id: "", entity_code: "", sftp_path: "", file_path: "", status: "Pending" }
  ]
};
