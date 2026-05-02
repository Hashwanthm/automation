const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const db = require('../config/database');


// ================================
// CONFIG
// ================================
const MAX_RETRIES = 3;
const DELAY_BETWEEN_CLIENTS = 3000; // 3 sec

// ================================
// SIMPLE LOGGER
// ================================
function log(message) {
    console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
}

// ================================
// RETRY WRAPPER
// ================================
async function retry(fn, retries = MAX_RETRIES) {
    for (let i = 1; i <= retries; i++) {
        try {
            return await fn();
        } catch (err) {
            log(`⚠️ Attempt ${i} failed: ${err.message}`);
            if (i === retries) throw err;
            await new Promise(res => setTimeout(res, 3000));
        }
    }
}


// ================================
// OPEN / CREATE FOLDER
// ================================
function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function openOrCreateFolder(page, folder) {

    await page.waitForLoadState('networkidle');

    const safeFolder = escapeRegex(folder);

    // 🔥 TARGET EXACT TEXT ELEMENT
    const folderLocator = page.locator(
        'span.text',
        { hasText: new RegExp(`^${safeFolder}$`, 'i') }
    );

    let exists = false;

    try {
        await folderLocator.first().waitFor({ state: 'visible', timeout: 3000 });
        exists = true;
    } catch {
        exists = false;
    }
}
    if (exists) {

        log(`📁 Exists -> ${folder}`);

        await folderLocator.first().click();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(800);

    } else {

        log(`📁 Creating -> ${folder}`);

        await page.getByRole('button', { name: /New Folder/i }).click();

        const dialog = page.locator('mat-dialog-container');
        await dialog.waitFor({ state: 'visible' });

        await dialog.locator('input').fill(folder);
        await dialog.getByRole('button', { name: /Create/i }).click();

        // 🔴 HANDLE already exists safely
        const alreadyExists = dialog.locator('text=already exists');

        if (await alreadyExists.isVisible().catch(() => false)) {
            log(`⚠️ Already exists (UI issue) -> ${folder}`);
            await dialog.getByRole('button', { name: /Cancel/i }).click();
                    } else {
            await dialog.waitFor({ state: 'hidden' });
        }

        await page.waitForLoadState('networkidle');

        // 🔥 OPEN AFTER CREATE
        await folderLocator.first().click();
    }
}

// ================================
// PROCESS ONE CLIENT
// ================================
async function processClient(page, client) {
    const client_code = client.client_code;
    const entity_code = client.entity_code;
    const month = client.month;

    await page.goto('https://secure.ind.adp.com/#/Aparajitha');

    const filesToUpload =[
        client.hrisFilePath,
        client.paysheetFilePath
    ].filter(Boolean);

    log(`🚀 Processing → ${client_code}`);

    await page.waitForLoadState('networkidle');

    const folders = client_code.split('/');


    for (const folder of folders) {
        await retry(() => openOrCreateFolder(page, folder));
    }

    // CHECK FILE
    const existingFile = page.locator('td.mat-cell', {
        hasText: fileName
    }).first();

    if (await existingFile.count() > 0) {
        log(`⚠️ Already exists -> ${fileName}`);

        await db.run(
            `UPDATE clients
             SET uploadstatus = 'Uploaded'
             WHERE TRIM(UPPER(client_code)) = TRIM(UPPER(?))
             AND TRIM(UPPER(month)) = TRIM(UPPER(?))`,
            [client.client_code, client.month]
        );

        global.send({
            type: "UPLOADED",
            client: client.client_code,
            entity: client.entity_code,
            month: client.month
        });

        return "SKIPPED";
    }
    // UPLOAD
const fileInput = page.locator('input[type="file"]:not([webkitdirectory])');

for (const filePath of filesToUpload) {
    const fileName = path.basename(filePath);

    if (!fs.existsSync(filePath)) {
        log(`File not found: ${filePath}`);
        continue;
    }

    const existingFile = page.locator('td.mat-cell', {
        hasText: fileName
    }).first();

    if (await existingFile.count() > 0) {
        log(`⚠️ Already exists -> ${fileName}`);
        continue;
    }
}
        await fileInput.setInputFiles(filePath);
        await page.waitForTimeout(3000);

        log(`✅ Uploaded -> ${fileName}`);
    }
    return "SUCCESS";

    await fileInput.setInputFiles(filePath);

    await page.waitForTimeout(3000);

    log(`✅ Uploaded → ${fileName}`);

    console.log("🚀 BEFORE UPDATE:", {
        client_code: client.client_code,
        month: client.month
    });

    const result = await db.run(
                `UPDATE clients
         SET uploadStatus = 'UPLOADED'
         WHERE client_code = ? AND month = ?`,
        [client.client_code, client.month]
    );

    console.log("🔥 DB RESULT:", result);

    //UI update SUCCESS
    global.send({
        type: "UPLOADED",
        client: client.client_code,
        entity: client.entity_code,
        month: client.month
    });
}

// ================================
// MAIN  FUNCTION
// ================================
async function uploadPaysheetBulk() {

    const browser = await chromium.launch({
        headless: false,
        channel: 'msedge'
    });
    const page = await browser.newPage();

    //
    const clients = await new Promise((resolve, reject) => {
        db.all(
            `SELECT client_code, entity_code, month, hrisFilePath, paysheetFilePath
             FROM clients
             WHERE status='Downloaded'
             AND hrisFilePath IS NOT NULL
             AND paysheetFilePath IS NOT NULL`,
            [],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            }
        );
    });

    console.log("Clients to upload:", clients.length);

    if (!clients || clients.length === 0) {
        console.log("❌ No clients found");
        return;
    }

    console.log("Clients to upload:", clients.length);

    const results = [];

    try {

        // LOGIN ONCE
        await page.goto('https://secure.ind.adp.com/Web/Account/Login.htm');

        await page.fill('#username', 'Aparajitha');
        await page.fill('#password', 'PKfAV1JI');

        await page.click('#loginSubmit');

        await page.waitForLoadState('networkidle');

        log("✅ Logged in");

        // SESSION KEEP ALIVE
        setInterval(async () => {
            try {
                await page.mouse.move(100, 100);
                await page.mouse.move(200, 200);
            } catch { }
        }, 20000);
                // LOOP CLIENTS
        for (const client of clients) {

            try {

                const result = await retry(() => processClient(page, client));

                results.push({
                    client: client.client_code,
                    status: result
                });

            } catch (err) {
                log(`❌ FAILED -> ${client.client_code}`);

                await db.run(
                    `UPDATE clients
                     SET uploadstatus = 'Failed'
                     WHERE TRIM(UPPER(client_code)) = TRIM(UPPER(?))
                     AND TRIM(UPPER(month)) = TRIM(UPPER(?))`,
                    [client.client_code, client.month]
                );
                                global.send({
                    type: "UPLOAD_FAILED",
                    client: client.client_code,
                    entity: client.entity_code,
                    month: client.month
                });

                results.push({
                    client: client.client_code,
                    status: "FAILED",
                    error: err.message
                });
            }

            log("⌛ Waiting 3 sec...");
            await page.waitForTimeout(DELAY_BETWEEN_CLIENTS);
        }

        } catch (err) {
        log("❌ Critical Error: " + err.message);
    }

    // SAVE RESULT
    fs.writeFileSync(
        'result.json',
        JSON.stringify(results, null, 2)
    );

    log("⬜ Results saved → result.json");

    // await browser.close();
}
module.exports = uploadPaysheetBuk;
