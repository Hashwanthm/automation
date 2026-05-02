const { runAutomation } = require('./automation/downloadAutomation');
const db = require('./config/database');
const express = require('express');
const path = require('path');
const { exec } = require('child_process');
const { readExcel } = require('./services/excelService');
const multer = require("multer");
const uploadPaysheetBulk = require('./automation/uploadAutomation');

const app = express();
const PORT = 3000;

/* ============================
 | STATIC FILES
============================= */
app.use(express.static(path.join(__dirname, 'public')));

/* ============================
 | SSE LOG STREAM
============================= */
let clients = [];

function send(message) {
  clients.forEach(c => c.write(`data: ${JSON.stringify(message)}\n\n`));
}

global.send = send;

app.get('/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  clients.push(res);

  req.on('close', () => {
    clients = clients.filter(c => c !== res);
  });
});

/* ============================
 | FILE UPLOAD
============================= */
const upload = multer({
  storage: multer.diskStorage({
    destination: "uploads/",
    filename: (req, file, cb) => {
      cb(null, Date.now() + "_" + file.originalname);
    }
  }),
  fileFilter: (req, file, cb) => {
    if (!file.originalname.endsWith(".xlsx")) {
      return cb(new Error("INVALID_FILE"), false);
    }
    cb(null, true);
  }
});

app.post("/upload", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "Invalid file uploaded"
      });
    }

    const filePath = req.file.path;

    const excelData = readExcel(filePath);

    db.serialize(() => {
      db.run("DELETE FROM clients");

      const stmt = db.prepare(`
        INSERT INTO clients
        (client_code, entity_code, month, paysheetFilePath, status,uploadStatus)
        VALUES (?, ?, ?, ?, ?,?)
      `);

      excelData.forEach(c => {
        stmt.run(
          c.clientCode,
          c.entityCode,
          c.month,
          c.filePath,
          "Pending",
          "Pending"
        );
      });

      db.all("SELECT COUNT(*) as total FROM clients", (err, rows) => {
        res.json({
          success: true,
          total: rows[0].total
        });
      });
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      error: "Upload failed"
    });
  }
});

/* ============================
 | START AUTOMATION (FROM DB)
============================= */
app.post('/start', async (req, res) => {

  console.log("🚀 Starting automation from DB...");

  db.all("SELECT * FROM clients", async (err, rows) => {

    if (err) return res.status(500).send("DB Error");

    if (!rows.length) {
      return res.status(400).send("No data in DB");
    }

    const data = rows.map(r => ({
      clientCode: r.client_code,
      entityCode: r.entity_code,
      month: r.month,
      filePath: r.file_path
    }));

    console.log("🚀 Download started...");
    await runAutomation(data);   // ✅ wait for download

    console.log("✅ Download completed");

    console.log("🚀 Upload started...");
    await uploadPaysheetBulk();  // ✅ then upload

    console.log("✅ Upload completed");

    res.send("✅ Full Process Completed"); // background

  });
});

/* ============================
 | GET CLIENTS (UI LOAD)
============================= */
app.get("/clients", (req, res) => {
  db.all("SELECT * FROM clients", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

/* ============================
 | START SERVER
============================= */
app.listen(PORT, () => {
  console.log(` http://localhost:${PORT}`);

  setTimeout(() => {
    exec(`start http://localhost:${PORT}`)
  }, 1000);
});
