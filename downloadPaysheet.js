const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');
const db = require('../config/database');
const { getToken } = require('./Session');

// DELAY
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

// Create folder
const downloadDir = path.join(__dirname, "downloads");

if (!fs.existsSync(downloadDir)) {
  fs.mkdirSync(downloadDir);
}

// ===============================
// DOWNLOAD FUNCTION
// ===============================
async function downloadPaysheet(clientData, authToken) {
  try {
    const { clientCode, entityCode, month } = clientData;

    const url =
      `https://adpvistahcm.ad.esi.adp.com/ESSAPI/v1/VistaReports/Payroll/PaySheet/${clientCode}/${entityCode}/${month}`;

    console.log(`📄 Processing ${clientCode}...`);

    const response = await axios.post(
      url,
      ["01", "FS", "FSADHOC", "REIMB"],
      {
        headers: {
          Authorization: authToken,
          "Content-Type": "application/json"
        },
        responseType: 'arraybuffer',
        httpsAgent: httpsAgent
      }
    );

    const filePath = path.join(
      downloadDir,
      `Paysheet_${clientCode}_${month}.xlsx`
    );

    fs.writeFileSync(filePath, response.data);

    console.log(`✅ Saved: ${filePath}`);

    await db.run(
      `UPDATE clients 
       SET localFilePath=?, status='Downloaded' 
       WHERE client_code=? AND month=?`,
      [filePath, clientCode, month]
    );

    console.log(`✅ DB Updated for ${clientCode}`);

  } catch (err) {
    console.log(`❌ Error for ${clientData.clientCode}:`, err.message);
    throw err;
  }
}

// ===============================
// STATUS TO UI
// ===============================
async function runAutomation(data) {
  const { authToken } = await getToken();

  for (const client of data) {

    // UI LIVE - START
    global.send({
      type: "START",
      client: client.clientCode,
      entity: client.entityCode,
      month: client.month
    });

    try {
      // your automation
      await downloadPaysheet(client, authToken);

      global.send({
        type: "SUCCESS",
        client: client.clientCode
      });

    } catch (err) {
      global.send({
        type: "FAILED",
        client: client.clientCode
      });
    }

    const waitTime = randomDelay(1000, 3000);
    console.log(`Waiting ${waitTime}ms`);
    await delay(waitTime);
  }

  console.log("All downloads completed");
}

module.exports = { runAutomation };
