// Vista report download automation.
// Downloads the HRIS and Paysheet workbooks for each client and records the
// resulting file paths back into SQLite for the upload stage.
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');
const db = require("../config/database");
const { getToken } = require("../services/session-service");

function runDb(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function waitWhilePaused() {
    while (global.automationPauseRequested && !global.automationStopRequested) {
        await delay(500);
    }
}

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// Vista endpoints in this environment may present certificates that local Node
// does not trust; the dedicated agent keeps that behavior isolated to these calls.
const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

const downloadDir = path.join(__dirname, "..", "temp");

if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
}

function safeFolderName(name) {
  return String(name).replace(/[<>:"/\\|?*]+/g, '_').trim();
}

// Each client gets a dedicated download folder so upload automation can pick up
// both generated sheets without relying on brittle filename searches.
function createClientFolder(clientName, entityCode) {
    const clientDir = path.join(
        downloadDir,
        safeFolderName(clientName),
        safeFolderName(entityCode || "ENTITY")
    );

    if (!fs.existsSync(clientDir)) {
        fs.mkdirSync(clientDir, { recursive: true });
    }

    return clientDir;
}

function hasExistingFile(filePath) {
    return Boolean(filePath && fs.existsSync(filePath));
}

function removePartialFile(filePath) {
    if (!filePath) return;
    try {
        fs.rmSync(filePath, { force: true });
    } catch {
        // Best effort cleanup only. The original download error is more useful.
    }
}

async function writeStreamToFile(stream, filePath) {
    const file = fs.createWriteStream(filePath);

    try {
        await new Promise((resolve, reject) => {
            stream.on("error", reject);
            file.on("finish", resolve);
            file.on("error", reject);
            stream.pipe(file);
        });
    } catch (err) {
        file.destroy();
        removePartialFile(filePath);
        throw err;
    }
}

function validateClientData(client) {
    if (!client?.clientCode) throw new Error("Client ID is missing for download.");
    if (!client?.entityCode) throw new Error(`Entity Code is missing for ${client.clientCode}.`);
    if (!client?.month) throw new Error(`Run month is missing for ${client.clientCode}.`);
}

async function downloadHRIS(clientData, authToken, clientDir) {
    try {

        const { clientCode, entityCode , month } = clientData;

        const url =
            `https://adpvistahcm.ad.esi.adp.com/ESSAPI/v1/VistaReports`;

        console.log(`⬜ Downloading HRIS for ${clientCode}...`);

        const response = await axios.get(url, {
            headers: {
                Authorization: authToken
            },
            params: { month },
            responseType: "stream",
            httpsAgent,
            timeout: 120000
        });

        const safeClientCode = safeFolderName(clientCode);
        const safeEntityCode = safeFolderName(entityCode || "ENTITY");
        const filePath = path.join(
            clientDir,
            `HRIS_${safeClientCode}_${safeEntityCode}_${month}.xlsx`
        );

        await writeStreamToFile(response.data, filePath);

        console.log(`✅ HRIS Saved: ${filePath}`);
        return filePath;

    } catch (err) {
        console.log(`❌ HRIS Error for ${clientData.clientCode}:`, err.message);
        throw err;
    }
}

// Paysheet is fetched through a POST API and written as an xlsx binary payload.
async function downloadPaysheet(clientData, authToken, clientDir) {
    try {
        const { clientCode, entityCode, month } = clientData;

        const url = "https://adpvistahcm.ad.esi.adp.com/ESSAPI/v1/VistaReports/Payroll/PaySheet";

        console.log(`⬜ Downloading Paysheet for ${clientCode}...`);

        const response = await axios.post(
            url,
            ["01", "FS", "FSADHOC", "REIMB"],
            {
                headers: {
                    Authorization: authToken,
                    "Content-Type": "application/json"
                },
                params: { month },
                responseType:"arraybuffer",
                httpsAgent,
                timeout: 120000
            }
        );

        const safeClientCode = safeFolderName(clientCode);
        const safeEntityCode = safeFolderName(entityCode || "ENTITY");
        const filePath = path.join(
            clientDir,
            `Paysheet_${safeClientCode}_${safeEntityCode}_${month}.xlsx`
        );

        fs.writeFileSync(filePath, response.data);

        console.log(`✅ Paysheet Saved: ${filePath}`);
        return filePath;

    } catch (err) {
        console.log(`❌ Paysheet Error for ${clientData.clientCode}:`, err.message);
        throw err;
    }
}

async function runAutomation(data) {
    if (!data.length) {
        console.log("No pending downloads found.");
        return;
    }

    const { authToken } = await getToken();

    // Process clients sequentially to avoid overwhelming the portal and to keep
    // progress messages ordered in the UI.
    for (const client of data) {
        try {
            validateClientData(client);
        } catch (err) {
            global.send({
                type: "FAILED",
                client: client?.clientCode || "-",
                entity: client?.entityCode || "-",
                month: client?.month || "-",
                error: err.message
            });
            continue;
        }

        await waitWhilePaused();

        if (global.automationStopRequested) {
            console.log("Automation stop requested. Download loop stopped.");
            break;
        }

        const clientDir = createClientFolder(client.clientCode, client.entityCode);

        global.send({
            type: "START",
            client: client.clientCode,
            entity: client.entityCode,
            month: client.month
        });

        let hrisPath = hasExistingFile(client.hrisFilePath) ? client.hrisFilePath : "";
        let paysheetPath = hasExistingFile(client.paysheetFilePath) ? client.paysheetFilePath : "";

        try {
            await runDb(
                `UPDATE entities
                 SET status='Processing', uploadStatus='Pending'
                 WHERE client_code=? AND entity_code=? AND month=?`,
                [client.clientCode, client.entityCode, client.month]
            );

            // Save each workbook as soon as it succeeds. A manual retry can then
            // continue from the missing workbook instead of repeating completed work.
            if (!hrisPath) {
                hrisPath = await downloadHRIS(client, authToken, clientDir);
                await runDb(
                    `UPDATE entities
                     SET hrisFilePath=?, status='Processing'
                     WHERE client_code=? AND entity_code=? AND month=?`,
                    [hrisPath, client.clientCode, client.entityCode, client.month]
                );
            }

            global.send({
                type: "HRIS_SUCCESS",
                client: client.clientCode,
                entity: client.entityCode,
                month: client.month,
                hrisPath
            });

            if (!paysheetPath) {
                paysheetPath = await downloadPaysheet(client, authToken, clientDir);
                await runDb(
                    `UPDATE entities
                     SET paysheetFilePath=?
                     WHERE client_code=? AND entity_code=? AND month=?`,
                    [paysheetPath, client.clientCode, client.entityCode, client.month]
                );
            }

            global.send({
                type: "PAYSHEET_SUCCESS",
                client: client.clientCode,
                entity: client.entityCode,
                month: client.month,
                paysheetPath
            });

            await runDb(
                ` UPDATE entities
                  SET hrisFilePath=?, paysheetFilePath=?, status='Downloaded'
                  WHERE client_code=? AND entity_code=? AND month=?`,
                [hrisPath, paysheetPath, client.clientCode, client.entityCode, client.month]
            );

            global.send({
                type: "SUCCESS",
                client: client.clientCode,
                entity: client.entityCode,
                month: client.month,
                hrisPath,
                paysheetPath
            });

        } catch (err) {
            await runDb(
                ` UPDATE entities
                  SET hrisFilePath=?, paysheetFilePath=?, status='Failed'
                  WHERE client_code=? AND entity_code=? AND month=?`,
                [hrisPath || null, paysheetPath || null, client.clientCode, client.entityCode, client.month]
            );

            global.send({
                type: "FAILED",
                client: client.clientCode,
                entity: client.entityCode,
                month: client.month,
                stage: hrisPath ? "PAYSHEET" : "HRIS",
                hrisPath,
                paysheetPath,
                error: err.message
            });
        }

        if (global.automationStopRequested) {
            console.log("Automation stop requested. Download loop will stop after current client.");
            break;
        }

        await waitWhilePaused();
        if (global.automationStopRequested) break;

        const waitTime = randomDelay(1000, 3000);
        console.log(`Waiting ${waitTime}ms`);
        await delay(waitTime);
    }

    console.log("All downloads completed");
}

module.exports = { runAutomation };
