// session.js
const { loginAndGetToken } = require('../services/authService');

let authToken = "";
let lastLoginTime = 0;

const TOKEN_TIME = 15 * 60 * 1000; // 15 minutes

async function getToken() {

    const now = Date.now();

    // First login
    if (!authToken) {
        console.log("⚠️ No token → logging in...");
        let session;
        try {
            session = await loginAndGetToken();
        } catch (err) {
            console.log("Login failed:", err.message);
            throw new Error("Login failed:" + err.message);
        }

        authToken = session.authToken;
        lastLoginTime = now;

        return { authToken };
    }

    // Expiry check
    if (now - lastLoginTime > TOKEN_TIME) {
        console.log("🔁 Token expired → re-login...");
        let session;
        try {
            session = await loginAndGetToken();
        } catch (err) {
            console.log("Re login failed:", err.message);
            throw new Error("Re login failed:" + err.message);
        }

        authToken = session.authToken;
        lastLoginTime = now;
    } else {
        console.log("⬜ Using existing token");
    }

    return { authToken };
}

module.exports = { getToken };
