import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configuredFactoryRuntimeSettings } from "@gamefactory/core";
import type { AnyReplayBundle } from "../lib/types";
import type { DesktopState } from "./contracts";
import { DesktopFactorySession, inferConfigPath } from "./session";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const rendererIndex = resolve(moduleDirectory, "../renderer/index.html");
const preloadPath = resolve(moduleDirectory, "../preload/preload.cjs");
let window: BrowserWindow | undefined;
let restored = false;
let rendererReport: { title: string; text: string } | undefined;
let smokeFinished = false;

protocol.registerSchemesAsPrivileged([{ scheme: "gamefactory-artifact", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const runtimeSettings = configuredFactoryRuntimeSettings();

function send(channel: string, value: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, value);
}

const session = new DesktopFactorySession(
  (state) => send("factory:state", state),
  (snapshot) => send("factory:snapshot", snapshot),
  350,
  (snapshot) => send("factory:project-snapshot", snapshot),
  runtimeSettings.dataRoot,
  runtimeSettings.worktreeRoot,
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
  const value = state.selection.kind === "project" && state.selection.projectPath
    ? { kind: "project", projectPath: state.selection.projectPath }
    : { kind: "campaign", campaignPath: state.selection.campaignPath, configPath: state.selection.configPath };
  await writeFile(settingsPath(), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function restore(): Promise<void> {
  const projectArg = argument("--project");
  if (projectArg) {
    const state = await session.openProject({ projectPath: resolve(projectArg) });
    await persist(state);
    return;
  }
  const campaignArg = argument("--campaign");
  const configArg = argument("--config");
  if (campaignArg) {
    const state = await session.open({ campaignPath: resolve(campaignArg), ...(configArg ? { configPath: resolve(configArg) } : {}) });
    await persist(state);
    return;
  }
  try {
    const value = JSON.parse(await readFile(settingsPath(), "utf8")) as { kind?: unknown; projectPath?: unknown; campaignPath?: unknown; configPath?: unknown };
    if (value.kind === "project" && typeof value.projectPath === "string") {
      await session.openProject({ projectPath: value.projectPath });
      return;
    }
    if (typeof value.campaignPath === "string" && typeof value.configPath === "string") {
      await session.open({ campaignPath: value.campaignPath, configPath: value.configPath });
    }
  } catch {
    // First launch, a moved project, or a malformed preference simply returns to the chooser.
  }
}

async function chooseProject(): Promise<DesktopState> {
  const selected = await dialog.showOpenDialog(window!, {
    title: "Choose a GameFactory project",
    properties: ["openFile"],
    filters: [{ name: "GameFactory project", extensions: ["json"] }],
  });
  if (selected.canceled || !selected.filePaths[0]) return session.getState();
  const state = await session.openProject({ projectPath: selected.filePaths[0] });
  await persist(state);
  return state;
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

async function promptForCredential(name: string): Promise<string | undefined> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) throw new Error("Credential name is invalid");
  if (process.platform !== "win32") throw new Error("Use `gamefactory credentials set` on this platform");
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$form=New-Object Windows.Forms.Form",
    "$form.Text='GameFactory credential'",
    "$form.Width=520; $form.Height=190; $form.StartPosition='CenterScreen'; $form.TopMost=$true",
    "$label=New-Object Windows.Forms.Label; $label.Text=('Enter '+$env:GAMEFACTORY_DESKTOP_CREDENTIAL_NAME); $label.Left=18; $label.Top=18; $label.Width=470",
    "$box=New-Object Windows.Forms.TextBox; $box.Left=18; $box.Top=48; $box.Width=465; $box.UseSystemPasswordChar=$true",
    "$ok=New-Object Windows.Forms.Button; $ok.Text='Store securely'; $ok.Left=350; $ok.Top=88; $ok.Width=133; $ok.DialogResult=[Windows.Forms.DialogResult]::OK",
    "$cancel=New-Object Windows.Forms.Button; $cancel.Text='Cancel'; $cancel.Left=262; $cancel.Top=88; $cancel.Width=80; $cancel.DialogResult=[Windows.Forms.DialogResult]::Cancel",
    "$form.Controls.AddRange(@($label,$box,$ok,$cancel)); $form.AcceptButton=$ok; $form.CancelButton=$cancel; $form.Add_Shown({$box.Focus()})",
    "if($form.ShowDialog() -eq [Windows.Forms.DialogResult]::OK){[Console]::Out.Write($box.Text)}"
  ].join("; ");
  const { stdout } = await new Promise<{ stdout: string }>((resolvePrompt, reject) => {
    const environment = Object.fromEntries(["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP"].flatMap((key) => {
      const entry = Object.entries(process.env).find(([candidate]) => candidate.toLowerCase() === key.toLowerCase());
      return entry?.[1] === undefined ? [] : [entry];
    }));
    const child = execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-Sta", "-Command", script], {
      windowsHide: true,
      encoding: "utf8",
      env: { ...environment, GAMEFACTORY_DESKTOP_CREDENTIAL_NAME: name }
    }, (error: Error | null, stdout: string) => error ? reject(error) : resolvePrompt({ stdout }));
    child.stdin?.end();
  });
  return stdout || undefined;
}

function registerIpc(): void {
  ipcMain.on("factory:renderer-ready", (event, report: { title?: unknown; text?: unknown }) => {
    trusted(event);
    if (typeof report?.title !== "string" || typeof report?.text !== "string") return;
    rendererReport = { title: report.title, text: report.text };
    void finishSmokeTest();
  });
  ipcMain.handle("factory:get-state", (event) => { trusted(event); return session.getState(); });
  ipcMain.handle("factory:get-snapshot", (event, runId: unknown) => {
    trusted(event);
    if (runId !== undefined && typeof runId !== "string") throw new Error("Run id must be a string");
    return session.getSnapshot(runId);
  });
  ipcMain.handle("factory:get-project-snapshot", (event, selection: unknown) => {
    trusted(event);
    if (selection !== undefined && (!selection || typeof selection !== "object" || Array.isArray(selection))) throw new Error("Project selection must be an object");
    const value = selection as { phaseId?: unknown; attemptId?: unknown; runId?: unknown } | undefined;
    for (const item of [value?.phaseId, value?.attemptId, value?.runId]) if (item !== undefined && typeof item !== "string") throw new Error("Project selection values must be strings");
    return session.getProjectSnapshot(value as { phaseId?: string; attemptId?: string; runId?: string } | undefined);
  });
  ipcMain.handle("factory:get-project-replay", (event) => { trusted(event); return session.getProjectReplay(); });
  ipcMain.handle("factory:choose-campaign", async (event) => { trusted(event); return chooseCampaign(); });
  ipcMain.handle("factory:choose-project", async (event) => { trusted(event); return chooseProject(); });
  ipcMain.handle("factory:start-run", async (event) => { trusted(event); return session.startRun(); });
  ipcMain.handle("factory:stop-run", async (event) => { trusted(event); return session.stopRun(); });
  ipcMain.handle("factory:refresh-readiness", async (event) => { trusted(event); return session.refreshReadiness(); });
  ipcMain.handle("factory:prompt-credential", async (event, name: unknown) => {
    trusted(event);
    if (typeof name !== "string") throw new Error("Credential name is required");
    const value = await promptForCredential(name);
    return value === undefined ? session.getState() : session.setCredential(name, value);
  });
  ipcMain.handle("factory:remove-credential", async (event, name: unknown) => {
    trusted(event);
    if (typeof name !== "string") throw new Error("Credential name is required");
    return session.removeCredential(name);
  });
  ipcMain.handle("factory:get-artifact-text", async (event, id: unknown) => {
    trusted(event);
    if (typeof id !== "string") throw new Error("Artifact id is required");
    return session.getArtifactText(id);
  });
  ipcMain.handle("factory:open-artifact", async (event, id: unknown) => {
    trusted(event);
    if (typeof id !== "string") throw new Error("Artifact id is required");
    const artifact = await session.resolveArtifact(id);
    const error = await shell.openPath(artifact.path);
    return error ? { opened: false, error } : { opened: true };
  });
  ipcMain.handle("factory:export-replay", async (event, bundle: AnyReplayBundle) => {
    trusted(event);
    if (bundle?.format !== "gamefactory-viewer-bundle" || (bundle.version !== 1 && bundle.version !== 2)) throw new Error("Invalid replay bundle");
    const campaign = bundle.version === 2 ? bundle.project?.project?.id ?? "factory-project" : bundle.snapshot?.campaign?.id ?? "factory-run";
    const suffix = bundle.version === 2 ? bundle.project.project.projectRunId : bundle.snapshot.runId;
    const result = await dialog.showSaveDialog(window!, {
      title: "Export GameFactory replay",
      defaultPath: `${campaign}-${suffix}.gamefactory.json`,
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
      { label: "Open Project...", accelerator: "CmdOrCtrl+Shift+O", click: () => reportAction(chooseProject) },
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
  protocol.handle("gamefactory-artifact", async (request) => {
    const url = new URL(request.url);
    const id = url.hostname === "artifact" ? url.pathname.replace(/^\//, "") : "";
    const artifact = await session.resolveArtifact(id);
    if (artifact.sizeBytes > 256 * 1024 * 1024) return new Response("Artifact exceeds the 256 MiB inline preview limit", { status: 413 });
    const contents = await readFile(artifact.path);
    return new Response(new Uint8Array(contents), { headers: { "Content-Type": artifact.mediaType, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" } });
  });
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
