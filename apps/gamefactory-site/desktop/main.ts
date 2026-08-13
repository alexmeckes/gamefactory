import { app, BrowserWindow, dialog, ipcMain, Menu, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ReplayBundle } from "../lib/types";
import type { DesktopState } from "./contracts";
import { DesktopFactorySession, inferConfigPath } from "./session";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const rendererIndex = resolve(moduleDirectory, "../renderer/index.html");
const preloadPath = resolve(moduleDirectory, "../preload/preload.cjs");
let window: BrowserWindow | undefined;
let restored = false;
let rendererReport: { title: string; text: string } | undefined;
let smokeFinished = false;

function send(channel: string, value: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, value);
}

const session = new DesktopFactorySession(
  (state) => send("factory:state", state),
  (snapshot) => send("factory:snapshot", snapshot),
);

function trusted(event: IpcMainEvent | IpcMainInvokeEvent): void {
  const source = event.senderFrame?.url;
  if (!source || source !== pathToFileURL(rendererIndex).href) throw new Error("Rejected IPC from an untrusted renderer");
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function finishSmokeTest(): Promise<void> {
  const output = argument("--smoke-output");
  if (!output || smokeFinished || !restored || !rendererReport || !window) return;
  smokeFinished = true;
  const snapshot = session.getSnapshot();
  const report = {
    renderer: rendererReport,
    state: session.getState(),
    snapshot: snapshot ? {
      campaignId: snapshot.campaign.id,
      runId: snapshot.runId,
      sequence: snapshot.sequence,
      experiments: snapshot.experiments.length,
      graphNodes: snapshot.graph.nodes.length,
      live: snapshot.live,
    } : undefined,
  };
  await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const screenshotOutput = argument("--screenshot-output");
  if (screenshotOutput) {
    const image = await window.webContents.capturePage();
    await writeFile(resolve(screenshotOutput), image.toPNG());
  }
  app.exit(0);
}

function settingsPath(): string { return join(app.getPath("userData"), "observatory.json"); }

async function persist(state: DesktopState): Promise<void> {
  if (!state.selection) return;
  await mkdir(dirname(settingsPath()), { recursive: true });
  await writeFile(settingsPath(), `${JSON.stringify({ campaignPath: state.selection.campaignPath, configPath: state.selection.configPath }, null, 2)}\n`, "utf8");
}

async function restore(): Promise<void> {
  const campaignArg = argument("--campaign");
  const configArg = argument("--config");
  if (campaignArg) {
    const state = await session.open({ campaignPath: resolve(campaignArg), ...(configArg ? { configPath: resolve(configArg) } : {}) });
    await persist(state);
    return;
  }
  try {
    const value = JSON.parse(await readFile(settingsPath(), "utf8")) as { campaignPath?: unknown; configPath?: unknown };
    if (typeof value.campaignPath === "string" && typeof value.configPath === "string") {
      await session.open({ campaignPath: value.campaignPath, configPath: value.configPath });
    }
  } catch {
    // First launch, a moved project, or a malformed preference simply returns to the chooser.
  }
}

async function chooseCampaign(): Promise<DesktopState> {
  const selected = await dialog.showOpenDialog(window!, {
    title: "Choose a GameFactory campaign",
    properties: ["openFile"],
    filters: [{ name: "GameFactory campaign", extensions: ["json"] }],
  });
  if (selected.canceled || !selected.filePaths[0]) return session.getState();
  const campaignPath = selected.filePaths[0];
  let configPath: string;
  try {
    configPath = await inferConfigPath(campaignPath);
  } catch {
    const config = await dialog.showOpenDialog(window!, {
      title: "Choose the matching factory.config.json",
      defaultPath: dirname(campaignPath),
      properties: ["openFile"],
      filters: [{ name: "Factory configuration", extensions: ["json"] }],
    });
    if (config.canceled || !config.filePaths[0]) return session.getState();
    configPath = config.filePaths[0];
  }
  const state = await session.open({ campaignPath, configPath });
  await persist(state);
  return state;
}

function registerIpc(): void {
  ipcMain.on("factory:renderer-ready", (event, report: { title?: unknown; text?: unknown }) => {
    trusted(event);
    if (typeof report?.title !== "string" || typeof report?.text !== "string") return;
    rendererReport = { title: report.title, text: report.text };
    void finishSmokeTest();
  });
  ipcMain.handle("factory:get-state", (event) => { trusted(event); return session.getState(); });
  ipcMain.handle("factory:get-snapshot", (event) => { trusted(event); return session.getSnapshot(); });
  ipcMain.handle("factory:choose-campaign", async (event) => { trusted(event); return chooseCampaign(); });
  ipcMain.handle("factory:start-run", async (event) => { trusted(event); return session.startRun(); });
  ipcMain.handle("factory:stop-run", async (event) => { trusted(event); return session.stopRun(); });
  ipcMain.handle("factory:export-replay", async (event, bundle: ReplayBundle) => {
    trusted(event);
    if (bundle?.format !== "gamefactory-viewer-bundle" || bundle.version !== 1) throw new Error("Invalid replay bundle");
    const campaign = bundle.snapshot?.campaign?.id ?? "factory-run";
    const result = await dialog.showSaveDialog(window!, {
      title: "Export GameFactory replay",
      defaultPath: `${campaign}-${bundle.snapshot.runId}.gamefactory.json`,
      filters: [{ name: "GameFactory replay", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    await writeFile(result.filePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    return { saved: true, path: result.filePath };
  });
}

function createWindow(): BrowserWindow {
  const next = new BrowserWindow({
    title: "GameFactory Observatory",
    width: 1560,
    height: 980,
    minWidth: 980,
    minHeight: 700,
    backgroundColor: "#0b0d0d",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  next.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  next.webContents.on("will-navigate", (event, url) => {
    if (url !== pathToFileURL(rendererIndex).href) event.preventDefault();
  });
  next.once("ready-to-show", () => next.show());
  void next.loadFile(rendererIndex);
  return next;
}

function installMenu(): void {
  const reportAction = (action: () => Promise<unknown>): void => {
    void action().catch((error: unknown) => {
      dialog.showErrorBox("GameFactory Observatory", error instanceof Error ? error.message : String(error));
    });
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "File", submenu: [
      { label: "Open Campaign...", accelerator: "CmdOrCtrl+O", click: () => reportAction(chooseCampaign) },
      { type: "separator" },
      { label: "Quit", role: "quit" },
    ] },
    { label: "Run", submenu: [
      { label: "Start", accelerator: "F5", click: () => reportAction(() => session.startRun()) },
      { label: "Stop Safely", accelerator: "Shift+F5", click: () => reportAction(() => session.stopRun()) },
    ] },
    { label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "togglefullscreen" }] },
  ]));
}

app.setAppUserModelId("ai.somethingbig.gamefactory.observatory");
void app.whenReady().then(async () => {
  registerIpc();
  installMenu();
  window = createWindow();
  await restore();
  restored = true;
  await finishSmokeTest();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) window = createWindow(); });
}).catch((error: unknown) => {
  dialog.showErrorBox("GameFactory Observatory could not start", error instanceof Error ? error.stack ?? error.message : String(error));
  app.quit();
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", (event) => {
  if (!session.getState().running) return;
  event.preventDefault();
  void session.dispose().finally(() => app.exit(0));
});
