/**
 * Service account credentials for Google APIs (Sheets, Drive, etc.).
 * Supports (first match wins):
 * - GOOGLE_SERVICE_ACCOUNT_JSON — full JSON string (recommended)
 * - GOOGLE_SERVICE_ACCOUNT — alias for the same JSON string
 * - GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY — PEM with \n escaped as needed
 */
function loadServiceAccountCredentials() {
  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT;
  if (rawJson && String(rawJson).trim()) {
    try {
      const parsed = JSON.parse(String(rawJson).trim());
      if (parsed.client_email && parsed.private_key) return parsed;
    } catch {
      throw new Error(
        "Invalid GOOGLE_SERVICE_ACCOUNT_JSON / GOOGLE_SERVICE_ACCOUNT: must be valid JSON with client_email and private_key."
      );
    }
  }
  const email = process.env.GOOGLE_CLIENT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (email && privateKey) {
    privateKey = String(privateKey).replace(/\\n/g, "\n");
    return {
      type: "service_account",
      client_email: email.trim(),
      private_key: privateKey,
    };
  }
  return null;
}

function hasServiceAccountEnv() {
  return loadServiceAccountCredentials() !== null;
}

module.exports = {
  loadServiceAccountCredentials,
  hasServiceAccountEnv,
};
