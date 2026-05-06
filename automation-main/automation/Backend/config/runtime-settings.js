// Runtime automation settings shared by API routes and automation workers.
// SQLite is the source of truth; this module keeps a cache so automation code can
// read settings without repeating database queries inside tight loops.
const fs = require("fs");
const path = require("path");
const db = require("./database");

const legacySettingsPath = path.join(__dirname, "..", "..", "data", "runtime-settings.json");

const defaultSettings = {
  sftpUrl: "https://example.com",
  sftpUser: "",
  sftpPass: "",
  vistaHeadless: false,
  sftpHeadless: false
};

const stringFields = ["sftpUrl", "sftpUser", "sftpPass"];
const booleanFields = ["vistaHeadless", "sftpHeadless"];
const settings = { ...defaultSettings };
let loaded = false;
let loadingPromise = null;

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

function normalizeSettingValue(key, value) {
  if (booleanFields.includes(key)) {
    return value === true || value === "true" || value === "1";
  }

  return typeof value === "string" ? value : "";
}

function serializeSettingValue(key, value) {
  if (booleanFields.includes(key)) {
    return value ? "true" : "false";
  }

  return typeof value === "string" ? value : "";
}

function readLegacySettings() {
  try {
    if (!fs.existsSync(legacySettingsPath)) return null;
    return JSON.parse(fs.readFileSync(legacySettingsPath, "utf8"));
  } catch {
    return null;
  }
}

async function persistSettings(nextSettings = settings) {
  const keys = [...stringFields, ...booleanFields];

  for (const key of keys) {
    await runDb(
      `INSERT INTO app_settings (setting_key, setting_value, period, common, updated_at)
       VALUES (?, ?, '', ?, CURRENT_TIMESTAMP)
       ON CONFLICT(setting_key) DO UPDATE SET
         setting_value = excluded.setting_value,
         common = excluded.common,
         updated_at = CURRENT_TIMESTAMP`,
      [key, serializeSettingValue(key, nextSettings[key]), key]
    );
  }
}

async function loadRuntimeSettings() {
  if (loaded) return getRuntimeSettings();
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const rows = await allDb("SELECT setting_key, setting_value FROM app_settings");
    const fromDb = {};
    rows.forEach((row) => {
      if (Object.prototype.hasOwnProperty.call(defaultSettings, row?.setting_key)) {
        fromDb[row.setting_key] = normalizeSettingValue(row.setting_key, row.setting_value);
      }
    });

    const legacySettings = rows.length ? null : readLegacySettings();
    const nextSettings = { ...defaultSettings, ...(legacySettings || {}), ...fromDb };

    [...stringFields, ...booleanFields].forEach((key) => {
      settings[key] = normalizeSettingValue(key, nextSettings[key]);
    });

    if (!rows.length) {
      await persistSettings(settings);
    }

    loaded = true;
    loadingPromise = null;
    return getRuntimeSettings();
  })().catch((err) => {
    loadingPromise = null;
    throw err;
  });

  return loadingPromise;
}

function getRuntimeSettings() {
  return { ...settings };
}

async function updateRuntimeSettings(nextSettings = {}) {
  await loadRuntimeSettings();

  stringFields.forEach((field) => {
    if (typeof nextSettings[field] === "string") {
      settings[field] = nextSettings[field];
    }
  });

  booleanFields.forEach((field) => {
    if (typeof nextSettings[field] === "boolean") {
      settings[field] = nextSettings[field];
    }
  });

  await persistSettings(settings);
  return getRuntimeSettings();
}

module.exports = {
  getRuntimeSettings,
  loadRuntimeSettings,
  updateRuntimeSettings
};
