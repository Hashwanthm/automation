// Company upload parser.
// Validates the operator-provided Excel/CSV sheet and converts it into the
// normalized records expected by the backend database.
const fs = require("fs");
const XLSX = require("xlsx");
const { cleanText, normalizeAndValidateClientRecord } = require("./client-normalizer");

const REQUIRED_FIELDS = [
  {
    key: "clientCode",
    label: "Company ID",
    aliases: ["client id", "client code", "company id"]
  },
  {
    key: "clientName",
    label: "Company Name",
    aliases: ["client name", "company", "company name"]
  },
  {
    key: "entityCode",
    label: "Entity Code",
    aliases: ["entity code", "entity"]
  },
  {
    key: "filePath",
    label: "SFTP Path",
    aliases: ["sftp path", "file path", "path"]
  }
];

function normalizeHeader(value) {
  return cleanText(value).toLowerCase();
}

function findHeader(headers, aliases) {
  return aliases.map((alias) => headers[alias]).find(Boolean);
}

function readExcel(filePath) {
  console.log("Validating company upload file...");

  if (!fs.existsSync(filePath)) {
    throw new Error("Uploaded file not found");
  }

  try {
    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    if (!rows.length) {
      throw new Error("File is empty");
    }

    // Headers are matched case-insensitively so minor spreadsheet formatting
    // changes do not break uploads.
    const headers = Object.keys(rows[0]).reduce((map, key) => {
      map[normalizeHeader(key)] = key;
      return map;
    }, {});

    const resolvedHeaders = REQUIRED_FIELDS.reduce((map, field) => {
      map[field.key] = findHeader(headers, field.aliases);
      return map;
    }, {});

    REQUIRED_FIELDS.forEach((field) => {
      if (!resolvedHeaders[field.key]) {
        throw new Error(`Missing required column: ${field.label}`);
      }
    });

    const clients = [];
    const seenEntityKeys = new Set();
    const duplicateEntityKeys = new Set();

    // Excel row numbers are one-based and include the header row, hence index + 2.
    rows.forEach((row, index) => {
      const rawClient = {
        clientCode: row[resolvedHeaders.clientCode],
        clientName: row[resolvedHeaders.clientName],
        entityCode: row[resolvedHeaders.entityCode],
        filePath: row[resolvedHeaders.filePath]
      };
      const hasAnyValue = Object.values(rawClient).some((value) => cleanText(value));

      if (!hasAnyValue) return;

      const normalized = normalizeAndValidateClientRecord(rawClient, `Row ${index + 2}`);

      const entityKey = `${normalized.clientCode.toLowerCase()}::${normalized.entityCode.toLowerCase()}`;
      if (seenEntityKeys.has(entityKey)) {
        duplicateEntityKeys.add(`${normalized.clientCode} / ${normalized.entityCode}`);
      }
      seenEntityKeys.add(entityKey);

      clients.push({
        clientName: normalized.clientName,
        clientCode: normalized.clientCode,
        entityCode: normalized.entityCode,
        filePath: normalized.filePath
      });
    });

    if (duplicateEntityKeys.size) {
      throw new Error(`Duplicate Company ID + Entity Code rows in Excel: ${Array.from(duplicateEntityKeys).join(", ")}`);
    }

    if (!clients.length) {
      throw new Error("No valid company rows found");
    }

    console.log(`Validation completed. Total companies: ${clients.length}`);
    return clients;
  } catch (err) {
    console.log("Upload file validation error:", err.message);
    throw new Error(err.message || "Wrong file format");
  }
}

module.exports = { readExcel };
