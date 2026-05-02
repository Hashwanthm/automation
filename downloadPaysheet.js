const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');
const db = require('../config/database');
const { getToken } = require('./Session');

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

const downloadDir = path.join(__dirname, "downloads");

if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
}

function safeFolderName(name) {
    return String(name).replace(/[<>:"/\\|?*]+/g, '_').trim();
}

function createClientFolder(clientName) {
    const folderName = safeFolderName(clientName);
    const clientDir = path.join(downloadDir, folderName);

    if (!fs.existsSync(clientDir)) {
        fs.mkdirSync(clientDir, { recursive: true });
    }

    return clientDir;
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
            responseType: "stream",
            httpsAgent
        });

        const filePath = path.join(
            clientDir,
            `HRIS_${clientCode}_${month}.xlsx`
        );

        const file = fs.createWriteStream(filePath);
        response.data.pipe(file);

        await new Promise((resolve, reject) => {
            file.on("finish", resolve);
            file.on("error", reject);
        });

        console.log(`✅ HRIS Saved: ${filePath}`);
        return filePath;

    } catch (err) {
        console.log(`❌ HRIS Error for ${clientData.clientCode}:`, err.message);
        throw err;
    }
}

async function downloadPaysheet(clientData, authToken, clientDir) {
    try {
        const { clientCode, entityCode, month } = clientData;

        const url =
            `
            https://adpvistahcm.ad.esi.adp.com/ESSAPI/v1/VistaReports/Payroll/PaySheet
            `;

        console.log(`⬜ Downloading Paysheet for ${clientCode}...`);

        const response = await axios.post(
            url,
            ["01", "FS", "FSADHOC", "REIMB"],
            {
                headers: {
                    Authorization: authToken,
                    "Content-Type": "application/json"
                },
                responseType:"arraybuffer",
                httpsAgent
            }
        );

        const filePath = path.join(
            clientDir,
            `Paysheet_${clientCode}_${month}.xlsx`
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
    const { authToken } = await getToken();

    for (const client of data) {
        const clientDir = createClientFolder(client.clientCode);

        global.send({
            type: "START",
            client: client.clientCode,
            entity: client.entityCode,
            month: client.month
        });

        try {
            const hrisPath = await downloadHRIS(client, authToken, clientDir);
            const paysheetPath = await downloadPaysheet(client, authToken, clientDir);

            await db.run(
                ` UPDATE clients
                  SET hrisFilePath=?, paysheetFilePath=?, status='Downloaded'
                  WHERE client_code=? AND month=?`,
                [hrisPath, paysheetPath, client.clientCode, client.month]
            );

            global.send({
                type: "SUCCESS",
                client: client.clientCode,
                hrisPath,
                paysheetPath
            });

        } catch (err) {
            await db.run(
                ` UPDATE clients
                  SET status='Failed'
                  WHERE client_code=? AND month=?`,
                [client.clientCode, client.month]
            );

            global.send({
                type: "FAILED",
                client: client.clientCode,
                error: err.message
            });
        }

        const waitTime = randomDelay(1000, 3000);
        console.log(`Waiting ${waitTime}ms`);
        await delay(waitTime);
    }

    console.log("All downloads completed");
}

module.exports = { runAutomation };
