// Normalization and validation shared by manual client configuration and Excel upload.
function cleanText(value) {
  return String(value ?? "").trim();
}

function titleCaseWords(value) {
  return cleanText(value).replace(/\b([A-Za-z])([A-Za-z]*)/g, (_, first, rest) => {
    return `${first.toUpperCase()}${rest.toLowerCase()}`;
  });
}

function normalizeClientRecord(record = {}) {
  const clientCode = cleanText(record.clientCode ?? record.client_id ?? record.clientId ?? record.client_code);
  const clientName = titleCaseWords(record.clientName ?? record.client_name ?? "");
  const entityCode = cleanText(record.entityCode ?? record.entity_code ?? "");
  const filePath = cleanText(record.filePath ?? record.sftp_path ?? record.sftpPath ?? record.file_path ?? "");
  const month = cleanText(record.month ?? "");
  const status = cleanText(record.status ?? "Pending") || "Pending";
  const uploadStatus = cleanText(record.uploadStatus ?? record.upload_status ?? "Pending") || "Pending";

  return {
    clientCode,
    clientName,
    entityCode,
    filePath,
    month,
    status,
    uploadStatus
  };
}

function validateClientRecord(record, rowLabel = "Client") {
  if (!record.clientCode) throw new Error(`${rowLabel}: Company ID is required.`);
  if (!record.clientName) throw new Error(`${rowLabel}: Company Name is required.`);
  if (!record.entityCode) throw new Error(`${rowLabel}: Entity Code is required.`);
  if (!/^\d{3}$/.test(record.entityCode)) throw new Error(`${rowLabel}: Entity Code must be exactly three digits.`);
  if (!record.filePath) throw new Error(`${rowLabel}: SFTP Path is required.`);
  if (!record.filePath.includes("/")) throw new Error(`${rowLabel}: SFTP Path must contain at least one forward slash (/).`);
}

function normalizeAndValidateClientRecord(record = {}, rowLabel) {
  const normalized = normalizeClientRecord(record);
  validateClientRecord(normalized, rowLabel);
  return normalized;
}

module.exports = {
  cleanText,
  titleCaseWords,
  normalizeClientRecord,
  normalizeAndValidateClientRecord
};
