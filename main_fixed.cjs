const { app, BrowserWindow, dialog, screen } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");

const APP_ROOT = path.resolve(__dirname, "..");
const BACKEND_PORT = process.env.PAYSHEET_DESKTOP_PORT || "3456";
const APP_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const ICON_PATH = path.join(APP_ROOT, "Frontend", "public", "favicon.svg");

let backendProcess = null;
let mainWindow = null;

function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });

      req.on("error", () => {
        if (Date.now() >= deadline) {
          reject(new Error("Backend server did not start in time."));
          return;
        }
        setTimeout(check, 500);
      });

      req.setTimeout(1500, () => {
        req.destroy();
      });
    };

    check();
  });
}

function startBackend() {
  if (backendProcess) return;

  backendProcess = spawn(process.execPath, [path.join(APP_ROOT, "Backend", "server.js")], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PORT: BACKEND_PORT,
      ELECTRON_RUN_AS_NODE: "1"
    },
    windowsHide: true,
    stdio: "ignore"
  });

  backendProcess.on("exit", () => {
    backendProcess = null;
  });
}

async function createWindow() {
  startBackend();

  try {
    await waitForServer(APP_URL);
  } catch (err) {
    dialog.showErrorBox("Paysheet Automation", err.message);
    app.quit();
    return;
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  // Automatically reduce UI size on laptop screens and keep normal size on desktop monitors.
  let zoomFactor = 1;

  if (width <= 1366) {
    zoomFactor = 0.8; // small laptop screens
  } else if (width <= 1600) {
    zoomFactor = 0.9; // medium laptop screens
  } else {
    zoomFactor = 1; // desktop monitor / large screen
  }

  mainWindow = new BrowserWindow({
    width: Math.min(1280, width),
    height: Math.min(720, height),
    minWidth: 1000,
    minHeight: 650,
    title: "Paysheet Automation",
    icon: ICON_PATH,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.maximize();

  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.webContents.setZoomFactor(zoomFactor);
  });

  await mainWindow.loadURL(APP_URL);
}

function stopBackend() {
  if (!backendProcess) return;
  backendProcess.kill();
  backendProcess = null;
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  stopBackend();
  app.quit();
});

app.on("before-quit", stopBackend);
