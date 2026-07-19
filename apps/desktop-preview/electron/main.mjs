import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";

app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1440, height: 810, minWidth: 960, minHeight: 540, backgroundColor: "#080b12", show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: !app.isPackaged } });
  window.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith("https://")) void shell.openExternal(url); return { action: "deny" }; });
  window.webContents.on("will-navigate", (event, url) => { if (!url.startsWith("file:")) event.preventDefault(); });
  void window.loadFile(join(import.meta.dirname, "../../../dist/desktop-preview/index.html"));
  window.once("ready-to-show", () => window.show());
});
app.on("window-all-closed", () => app.quit());
