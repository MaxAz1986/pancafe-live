// Pancafe Live for Windows: a desktop window onto the live dashboard website,
// so design changes reach the app without reinstalling it.
const { app, BrowserWindow, shell, Menu } = require("electron");
const path = require("path");

const HOME = "https://maxaz1986.github.io/pancafe-live/";
const HOST = "maxaz1986.github.io";

if (!app.requestSingleInstanceLock()) app.quit();

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 380, minHeight: 500,
    backgroundColor: "#0e1a17", title: "Pancafe Live", autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  win.loadURL(HOME);

  // Links to other sites open in the normal browser.
  const external = (url) => { try { return new URL(url).host !== HOST; } catch { return true; } };
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (external(url) && !url.startsWith("file:")) { e.preventDefault(); shell.openExternal(url); } });

  win.webContents.on("did-fail-load", (_e, code, _desc, url, isMain) => {
    if (isMain && code !== -3) win.loadFile(path.join(__dirname, "offline.html"));
  });
  // F5 / Ctrl+R reload, F11 full screen, Ctrl+Shift+I developer tools.
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F5" || (input.control && input.key.toLowerCase() === "r")) { win.loadURL(HOME); e.preventDefault(); }
    if (input.key === "F11") { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (input.control && input.shift && input.key.toLowerCase() === "i") win.webContents.toggleDevTools();
  });
}

app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
