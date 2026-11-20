"use strict";
// Riochi pour Windows : une fenêtre Electron qui affiche le dossier www/ (le même que dans l'APK).
const { app, BrowserWindow, ipcMain, protocol, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const bridge = require("./http-bridge");

const WWW = path.join(__dirname, "..", "www");
const ORIGIN = "app://riochi";
const NATIVE_PATH = "/__riochi/native-http.js";
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

// app:// se comporte comme https:// (contexte sécurisé : crypto.subtle, stockage local stable, etc.).
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();

function serve(request) {
  let rel;
  try { rel = decodeURIComponent(new URL(request.url).pathname); } catch (e) { return new Response("Bad request", { status: 400 }); }
  if (rel === "/" || rel === "") rel = "/index.html";

  const file = rel === NATIVE_PATH ? path.join(__dirname, "native-http.js") : path.normalize(path.join(WWW, rel));
  if (rel !== NATIVE_PATH && !file.startsWith(WWW + path.sep)) return new Response("Forbidden", { status: 403 });

  return fs.promises.readFile(file).then(
    (buf) => {
      if (rel === "/index.html") {
        // Le pont HTTP natif doit être chargé avant tous les autres scripts.
        buf = Buffer.from(buf.toString("utf8").replace(/<head[^>]*>/i, (m) => m + `<script src="${NATIVE_PATH}"></script>`));
      }
      return new Response(buf, { headers: { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-cache" } });
    },
    () => new Response("Not found", { status: 404 })
  );
}

function trusted(event) {
  const url = event.senderFrame && event.senderFrame.url;
  return typeof url === "string" && url.startsWith(ORIGIN + "/");
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 480,
    minHeight: 420,
    backgroundColor: "#16132a",
    autoHideMenuBar: true,
    title: "Riochi",
    icon: path.join(__dirname, "..", "resources", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      allowRunningInsecureContent: true, // flux vidéo en http:// (comme allowMixedContent sous Android)
    },
  });

  // Les liens externes s'ouvrent dans le navigateur, jamais dans la fenêtre de l'appli.
  const external = (url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(ORIGIN + "/")) { e.preventDefault(); external(url); } });

  win.loadURL(ORIGIN + "/index.html");
  return win;
}

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

app.whenReady().then(() => {
  app.setAppUserModelId("fr.riochi.app");
  protocol.handle("app", serve);
  ipcMain.handle("riochi:http", (event, req) => {
    if (!trusted(event)) throw new Error("Origine non autorisée");
    return bridge.request(req);
  });
  ipcMain.on("riochi:abort", (event, id) => { if (trusted(event)) bridge.abort(id); });

  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("second-instance", () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
