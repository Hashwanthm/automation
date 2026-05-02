const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const db = require('../config/database'); // use DB here

function readExcel(filePath) {

    console.log("Validating Excel sheet...");

    try {

        if (!fs.existsSync(filePath)) {
            throw new Error("❌ Excel file 'clients.xlsx' not found");
        }

        const workbook = XLSX.readFile(filePath);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];

        // 🔥 Read header row
        const header = XLSX.utils.sheet_to_json(sheet, { header: 1 })[0];

        const expectedHeaders = [
            "client code",
            "entity code",
            "month",
            "file path"
        ];

        // ✅ STRICT HEADER VALIDATION
        if (!header || header.length < 4) {
            throw new Error('❌ Excel must contain 4 columns');
        }

        expectedHeaders.forEach((col, index) => {
            const actual = header[index] ? header[index].toString().trim().toLowerCase() : "";

            if (actual !== col.toLowerCase()) {
                throw new Error(
                    `❌ Column ${String.fromCharCode(65 + index)} must be "${col}"`
                );
            }
        });

        // 🔥 Convert to JSON using headers
        const data = XLSX.utils.sheet_to_json(sheet);

        if (data.length === 0) {
            throw new Error("❌ Excel file is empty");
        }

        let clients = [];

        data.forEach((row, index) => {

            // 🔥 Trim values
            const client = row["client code"] ? row["client code"].toString().trim() : "";
            const entity = row["entity code"] ? row["entity code"].toString().trim() : "";
            const month = row["month"] ? row["month"].toString().trim() : "";
            const filePath = row["file path"] ? row["file path"].toString().trim() : "";

            // ❌ Ignore completely empty rows
            if (!client && !entity && !month && !filePath) {
                return;
            }

            // ❌ Missing data check
            if (!client || !entity || !month || !filePath) {
                throw new Error(`❌ Missing data in row ${index + 2}`);
            }

            // ❌ REMOVED file existence check (IMPORTANT CHANGE)

            clients.push({
                clientCode: client,
                entityCode: entity,
                month: month,
                filePath: filePath // 👉 used later for saving + uploading
            });
        });

        if (clients.length === 0) {
            throw new Error("❌ No valid data found in Excel");
        }

        console.log(`✅ Validation completed (Total clients: ${clients.length})`);

        return clients;

    } catch (err) {
        console.log("Excel Error:", err.message);
        throw new Error("WRONG EXCEL FORMAT"); // Custom error for wrong format
    }
}

module.exports = { readExcel };
