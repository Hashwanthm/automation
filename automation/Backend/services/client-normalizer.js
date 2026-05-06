// Normalization and validation shared by manual client configuration and Excel upload.
function cleanText(value) {
  return String(value ?? "").trim();
}

function titleCaseWords(value) {
  return cleanText(value).replace(/\b([A-Za-z])([A-Za-z]*)/g, (_, first, rest) => {
    return `${first.toUpperCase()}${rest.toLowerCase()}`;
  });
}

function normalizeEntityRecord(record = {}) {
  const entityCode = cleanText(record.entityCode ?? record.entity_code ?? "");
  const filePath = cleanText(record.filePath ?? record.sftp_path ?? record.sftpPath ?? record.file_path ?? "");
  const status = cleanText(record.status ?? "Pending") || "Pending";

  return {
    id: cleanText(record.id ?? ""),
    entityCode,
    entity_code: entityCode,
    filePath,
    sftp_path: filePath,
    file_path: filePath,
    status
  };
}

function normalizeClientRecord(record = {}) {
  const clientCode = cleanText(record.clientCode ?? record.client_id ?? record.clientId ?? record.client_code);
  const clientName = titleCaseWords(record.clientName ?? record.client_name ?? "");
  const entityCode = cleanText(record.entityCode ?? record.entity_code ?? "") || "001";
  const filePath = cleanText(record.filePath ?? record.sftp_path ?? record.sftpPath ?? record.file_path ?? "");
  const month = cleanText(record.month ?? "");
  const status = cleanText(record.status ?? "Pending") || "Pending";
  const uploadStatus = cleanText(record.uploadStatus ?? record.upload_status ?? "Pending") || "Pending";
  const hasEntities = Boolean(record.hasEntities ?? record.has_entities);
  const entities = Array.isArray(record.entities) ? record.entities.map(normalizeEntityRecord) : [];

  return {
    clientCode,
    clientName,
    entityCode,
    filePath,
    month,
    status,
    uploadStatus,
    hasEntities,
    entities
  };
}

function validateSftpPath(filePath, rowLabel) {
  if (!filePath) throw new Error(`${rowLabel}: SFTP Path is required.`);
  if (!filePath.includes("/")) throw new Error(`${rowLabel}: SFTP Path must contain at least one forward slash (/).`);
}

function validateClientRecord(record, rowLabel = "Client") {
  if (!record.clientCode) throw new Error(`${rowLabel}: Company ID is required.`);
  if (!record.clientName) throw new Error(`${rowLabel}: Company Name is required.`);
  if (!record.entityCode) throw new Error(`${rowLabel}: Entity Code is required.`);
  if (!/^\d{3}$/.test(record.entityCode)) throw new Error(`${rowLabel}: Entity Code must be exactly three digits.`);
  validateSftpPath(record.filePath, rowLabel);
}

function validateClientConfiguration(record, rowLabel = "Client") {
  if (!record.clientCode) throw new Error(`${rowLabel}: Company ID is required.`);
  if (!record.clientName) throw new Error(`${rowLabel}: Company Name is required.`);

  if (!record.hasEntities) {
    validateSftpPath(record.filePath, rowLabel);
    return;
  }

  if (!record.entities.length) {
    throw new Error(`${rowLabel}: Add at least one entity.`);
  }

  const seen = new Set();
  record.entities.forEach((entity, index) => {
    const label = `${rowLabel} Entity ${index + 1}`;
    if (!entity.entityCode) throw new Error(`${label}: Entity Code is required.`);
    if (!/^\d{3}$/.test(entity.entityCode)) throw new Error(`${label}: Entity Code must be exactly three digits.`);
    const entityKey = entity.entityCode.toLowerCase();
    if (seen.has(entityKey)) throw new Error(`${label}: Entity Code must be unique for the company.`);
    seen.add(entityKey);
    validateSftpPath(entity.filePath, label);
  });
}

function normalizeAndValidateClientRecord(record = {}, rowLabel) {
  const normalized = normalizeClientRecord(record);
  validateClientRecord(normalized, rowLabel);
  return normalized;
}

function normalizeAndValidateClientConfiguration(record = {}, rowLabel) {
  const normalized = normalizeClientRecord(record);
  validateClientConfiguration(normalized, rowLabel);
  return normalized;
}

module.exports = {
  cleanText,
  titleCaseWords,
  normalizeEntityRecord,
  normalizeClientRecord,
  normalizeAndValidateClientRecord,
  normalizeAndValidateClientConfiguration
};
