// Token cache for Vista API access.
// Keeps the expensive browser login out of the hot path while refreshing before
// the captured token becomes too old for downstream report requests.
const { loginAndGetToken } = require("./auth-service");

let authToken = "";
let lastLoginTime = 0;

const TOKEN_TIME = 15 * 60 * 1000; // 15 minutes

async function getToken() {

    const now = Date.now();

    // First login: no token has been captured yet for this backend process.
    if (!authToken) {
        console.log("⚠️ No token → logging in...");
        let session;
        try {
            session = await loginAndGetToken();
        } catch (err) {
            console.log("Login failed:", err.message);
            const message = err.message === "CANNOT LOGIN" ? "CANNOT LOGIN" : `Login failed: ${err.message}`;
            throw new Error(message);
        }

        if (!session?.authToken) {
            throw new Error("Login failed: authorization token was empty.");
        }

        authToken = session.authToken;
        lastLoginTime = now;

        return { authToken };
    }

    // Expiry check: refresh proactively rather than waiting for an API failure.
    if (now - lastLoginTime > TOKEN_TIME) {
        console.log("🔁 Token expired → re-login...");
        let session;
        try {
            session = await loginAndGetToken();
        } catch (err) {
            console.log("Re login failed:", err.message);
            const message = err.message === "CANNOT LOGIN" ? "CANNOT LOGIN" : `Re login failed: ${err.message}`;
            throw new Error(message);
        }

        if (!session?.authToken) {
            throw new Error("Re login failed: authorization token was empty.");
        }

        authToken = session.authToken;
        lastLoginTime = now;
    } else {
        console.log("⬜ Using existing token");
    }

    return { authToken };
}

module.exports = { getToken };
