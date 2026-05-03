// SFTP upload automation.
// Uploads both required client workbooks (HRIS and Paysheet) into the destination
// portal folder and updates upload status in the local database.
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const db = require("../config/database");
const { getRuntimeSettings, loadRuntimeSettings } = require("../config/runtime-settings");

const DELAY_BETWEEN_CLIENTS = 3000;
const PORTAL_URL = "https://secure.ind.adp.com/#/Aparajitha";
const LOGIN_URL = "https://secure.ind.adp.com/Web/Account/Login.htm";

function log(message) {
  console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
  global.log?.(message, { type: "UPLOAD_LOG" });
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitWhilePaused() {
  while (global.automationPauseRequested && !global.automationStopRequested) {
    await delay(500);
  }
}

async function loginToAparajitha(page, uploadUser, uploadPassword) {
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      if (attempt > 1) {
        log("Retrying Aparajitha login...");
      }

      await page.goto(LOGIN_URL, { waitUntil: "networkidle", timeout: 60000 });
      await page.fill("#username", uploadUser);
      await page.fill("#password", uploadPassword);
      await page.click("#loginSubmit");
      await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});

      // Confirm the authenticated session by opening the upload portal. If the
      // session is rejected, the site returns to the login screen.
      await page.goto(PORTAL_URL, { waitUntil: "networkidle", timeout: 60000 });
      const stillOnLogin = page.url().includes("/Web/Account/Login");
      const loginFormVisible = await page.locator("#username").isVisible({ timeout: 1500 }).catch(() => false);

      if (stillOnLogin || loginFormVisible) {
        throw new Error("Upload portal rejected credentials.");
      }

      log("Logged in to upload portal.");
      return;
    } catch (err) {
      lastError = err;
      log(`Aparajitha login attempt ${attempt} failed: ${err.message}`);

      if (attempt < 2) {
        await delay(1500);
      }
    }
  }

  log(`Aparajitha login failed after retry: ${lastError?.message || "Unknown error"}`);
  throw new Error("CANNOT LOGIN TO APARJITHA");
}

// Escape user/client folder names before building a text-matching regular expression.
function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function openOrCreateFolder(page, folder) {
  if (!folder) return;

  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});

  const safeFolder = escapeRegex(folder);
  const folderLocator = page.locator("span.text", {
    hasText: new RegExp(`^${safeFolder}$`, "i")
  });

  const exists = await folderLocator.first().isVisible({ timeout: 3000 }).catch(() => false);

  if (exists) {
    log(`Folder exists -> ${folder}`);
    await folderLocator.first().click();
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(800);
    return;
  }

  log(`Creating folder -> ${folder}`);
  await page.getByRole("button", { name: /New Folder/i }).click();

  const dialog = page.locator("mat-dialog-container");
  await dialog.waitFor({ state: "visible", timeout: 15000 });
  await dialog.locator("input").fill(folder);
  await dialog.getByRole("button", { name: /Create/i }).click();

  const alreadyExists = dialog.locator("text=already exists");
  if (await alreadyExists.isVisible().catch(() => false)) {
    await dialog.getByRole("button", { name: /Cancel/i }).click();
  } else {
    await dialog.waitFor({ state: "hidden", timeout: 15000 }).catch(() => {});
  }

  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await folderLocator.first().click();
}

// A client is complete only when both required report files are available.
function getRequiredUploadFiles(client) {
  return [
    { type: "HRIS", filePath: client.hrisFilePath },
    { type: "Paysheet", filePath: client.paysheetFilePath }
  ];
}

async function processClient(page, client) {
  const filesToUpload = getRequiredUploadFiles(client);
  // Fail early before portal navigation when either workbook is missing locally.
  const missingFiles = filesToUpload
    .filter((file) => !file.filePath || !fs.existsSync(file.filePath))
    .map((file) => file.type);

  if (missingFiles.length) {
    throw new Error(`Missing required upload file(s): ${missingFiles.join(", ")}`);
  }

  log(`Processing upload -> ${client.client_code}`);
  global.send?.({
    type: "UPLOAD_START",
    client: client.client_code,
    entity: client.entity_code,
    month: client.month
  });

  await runDb(
    `UPDATE entities
     SET uploadStatus='Processing'
     WHERE client_code=? AND entity_code=? AND month=?`,
    [client.client_code, client.entity_code, client.month]
  );

  await page.goto(PORTAL_URL, { waitUntil: "networkidle", timeout: 60000 });

  // Client codes can represent nested folder paths, separated by slash.
  const destinationPath = client.sftp_path || `${client.client_code}/${client.entity_code || ""}`;
  const folders = String(destinationPath || "")
    .split("/")
    .map((item) => item.trim())
    .filter(Boolean);

  for (const folder of folders) {
    await openOrCreateFolder(page, folder);
  }

  const fileInput = page.locator('input[type="file"]:not([webkitdirectory])');
  const completedUploads = [];

  for (const file of filesToUpload) {
    const { type, filePath } = file;
    const fileName = path.basename(filePath);

    // Treat files already present in the destination as completed uploads so
    // retrying a client is idempotent.
    const existingFile = page.locator("td.mat-cell", { hasText: fileName }).first();
    if (await existingFile.isVisible({ timeout: 1500 }).catch(() => false)) {
      log(`${type} already exists -> ${fileName}`);
      completedUploads.push(type);
      continue;
    }

    await fileInput.setInputFiles(filePath);
    await page.waitForTimeout(3000);
    completedUploads.push(type);
    log(`${type} uploaded -> ${fileName}`);
  }

  if (completedUploads.length !== filesToUpload.length) {
    throw new Error(`Expected ${filesToUpload.length} files, completed ${completedUploads.length}`);
  }

  await runDb(
    `UPDATE entities
     SET uploadStatus='Uploaded'
     WHERE client_code=? AND entity_code=? AND month=?`,
    [client.client_code, client.entity_code, client.month]
  );

  global.send?.({
    type: "UPLOADED",
    client: client.client_code,
    entity: client.entity_code,
    month: client.month,
    files: completedUploads
  });

  return "SUCCESS";
}

async function getClientsToUpload(options = {}) {
  const params = [];
  const { clientCode, entityCode, month } = options;
  // Only clients with both downloaded sheets are eligible for upload.
  let sql = `
    SELECT
      COALESCE(c.client_id, c.client_code, e.client_id, e.client_code) AS client_code,
      c.client_name,
      e.entity_code,
      e.month,
      e.sftp_path,
      e.hrisFilePath,
      e.paysheetFilePath
    FROM entities e
    JOIN clients c ON c.id = e.client_ref_id
    WHERE e.status='Downloaded'
      AND COALESCE(e.uploadStatus, 'Pending') <> 'Uploaded'
      AND e.hrisFilePath IS NOT NULL
      AND e.paysheetFilePath IS NOT NULL
  `;

  if (clientCode) {
    sql += " AND lower(COALESCE(c.client_id, c.client_code, e.client_id, e.client_code))=lower(?)";
    params.push(clientCode);
  }

  if (entityCode) {
    sql += " AND lower(e.entity_code)=lower(?)";
    params.push(entityCode);
  }

  if (month) {
    sql += " AND e.month=?";
    params.push(month);
  }

  return allDb(sql, params);
}

async function uploadPaysheetBulk(options = {}) {
  const clients = await getClientsToUpload(options);
  const results = [];

  if (!clients.length) {
    log("No downloaded clients found for upload.");
    return results;
  }

  await loadRuntimeSettings();
  const { sftpHeadless, sftpUser, sftpPass } = getRuntimeSettings();
  const uploadUser = sftpUser || process.env.ADP_UPLOAD_USER;
  const uploadPassword = sftpPass || process.env.ADP_UPLOAD_PASSWORD;

  if (!uploadUser || !uploadPassword) {
    throw new Error("Upload portal username and password are not configured. Update Settings before starting upload automation.");
  }

  let browser;

  try {
    browser = await chromium.launch({
      headless: Boolean(sftpHeadless),
      channel: "msedge"
    });

    const page = await browser.newPage();

    await loginToAparajitha(page, uploadUser, uploadPassword);

    // Upload clients sequentially to keep portal navigation stable.
    for (const client of clients) {
      await waitWhilePaused();
      if (global.automationStopRequested) break;

      try {
        const result = await processClient(page, client);
        results.push({ client: client.client_code, status: result });
      } catch (err) {
        log(`Upload failed -> ${client.client_code}: ${err.message}`);
        await runDb(
          `UPDATE entities
           SET uploadStatus='Failed'
           WHERE client_code=? AND entity_code=? AND month=?`,
          [client.client_code, client.entity_code, client.month]
        ).catch((dbErr) => {
          log(`Could not mark upload failed -> ${client.client_code}: ${dbErr.message}`);
        });

        global.send?.({
          type: "UPLOAD_FAILED",
          client: client.client_code,
          entity: client.entity_code,
          month: client.month,
          error: err.message
        });

        results.push({
          client: client.client_code,
          status: "FAILED",
          error: err.message
        });
      }

      if (global.automationStopRequested) break;

      await waitWhilePaused();
      if (global.automationStopRequested) break;

      await page.waitForTimeout(DELAY_BETWEEN_CLIENTS);
    }
  } finally {
    try {
      fs.writeFileSync(path.join(__dirname, "..", "result.json"), JSON.stringify(results, null, 2));
    } catch (err) {
      log(`Could not save upload results: ${err.message}`);
    }
    await browser?.close().catch(() => {});
    log("Upload results saved.");
  }

  return results;
}

module.exports = uploadPaysheetBulk;
