// Vista authentication helper.
// Opens the Vista portal with Playwright and captures the authorization header
// required by report download APIs.
const { chromium } = require("playwright");

async function attemptVistaLogin() {
  let authToken = "";
  let browser;

  try {
    browser = await chromium.launch({
      headless: false,
      channel: "msedge"
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    console.log("Logging in to Vista...");

    // The token is not exposed in the DOM; capture it from the API request that
    // Vista emits after the ESS area has loaded.
    page.on("request", (request) => {
      const headers = request.headers();
      const url = request.url();

      if (url.includes("GetCompanyInfo") && headers.authorization) {
        authToken = headers.authorization;
        console.log("Vista authorization token captured.");
      }
    });

    // Open the Vista launch page for the current operator session.
    await page.goto("https://adpvistahcm.ad.esi.adp.com/CoreUI/openIdLaunch", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    // Navigate into the ESS experience so the tokenized API request is emitted.
    await page.click("text=Explore Admin ESS", { timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});

    console.log("Triggering Vista API request...");

    await page.waitForSelector(".link-color", { timeout: 60000 });

    const clients = page.locator(".link-color");
    if (await clients.count() > 0) {
      await clients.first().click();
      console.log("Vista client link opened.");
    } else {
      throw new Error("Vista client link was not found.");
    }

    await page.waitForTimeout(3000);
    if (!authToken) {
      throw new Error("Vista authorization token was not captured.");
    }

    // Keep the browser available because portal sessions may need visible user
    // interaction during a run.
    // await browser.close();

    console.log("Vista token ready.");

    return { authToken };
  } catch (err) {
    await browser?.close().catch(() => {});
    throw err;
  }
}

async function loginAndGetToken() {
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      if (attempt > 1) {
        console.log("Retrying Vista login...");
      }

      return await attemptVistaLogin();
    } catch (err) {
      lastError = err;
      console.log(`Vista login attempt ${attempt} failed: ${err.message}`);
    }
  }

  console.log("Vista login failed after retry:", lastError?.message || "Unknown error");
  throw new Error("CANNOT LOGIN");
}

module.exports = { loginAndGetToken };
