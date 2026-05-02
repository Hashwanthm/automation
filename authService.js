// login.js
const { chromium } = require('playwright');

async function loginAndGetToken() {

    let authToken = "";

    const browser = await chromium.launch({
        headless: false,
        channel: 'msedge'
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    console.log("🔐 Logging in...");

    // 🔥 Capture token from request headers
    page.on('request', request => {
        const headers = request.headers();
        const url = request.url();

        if (url.includes("GetCompanyInfo") && headers.authorization) {
            authToken = headers.authorization;
            console.log("🔥 TOKEN CAPTURED");
        }
    });

    // 🌐 Open your site
    await page.goto("https://adpvistahcm.ad.esi.adp.com/CoreUI/openIdLaunch"); //url1

    // 👉 Click ESS
    await page.click('text=Explore Admin ESS');

    // Wait login complete
    await page.waitForLoadState('networkidle');

    console.log("⚡ Triggering API...");

    await page.waitForSelector('.link-color');

    const clients = page.locator('.link-color');

    if (await clients.count() > 0) {
        await clients.first().click();
        console.log("⬜ clicked");
    } else {
        console.log("❌ Not clicked");
    }

    await page.waitForTimeout(3000);

    //await browser.close();

    console.log("✅ Token ready\n");

    return { authToken };
}

module.exports = { loginAndGetToken };
