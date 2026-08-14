import { contextBridge, ipcRenderer } from "electron";
import type { DesktopFactoryApi, DesktopState } from "./contracts";
import type { AnyReplayBundle, FactorySnapshot, ProjectReplayBundle, ProjectSnapshot } from "../lib/types";

const api: DesktopFactoryApi = {
  getState: () => ipcRenderer.invoke("factory:get-state") as Promise<DesktopState>,
  getSnapshot: (runId?: string) => ipcRenderer.invoke("factory:get-snapshot", runId) as Promise<FactorySnapshot | undefined>,
  getProjectSnapshot: (selection) => ipcRenderer.invoke("factory:get-project-snapshot", selection) as Promise<ProjectSnapshot | undefined>,
  getProjectReplay: () => ipcRenderer.invoke("factory:get-project-replay") as Promise<ProjectReplayBundle | undefined>,
  chooseCampaign: () => ipcRenderer.invoke("factory:choose-campaign") as Promise<DesktopState>,
  chooseProject: () => ipcRenderer.invoke("factory:choose-project") as Promise<DesktopState>,
  startRun: () => ipcRenderer.invoke("factory:start-run") as Promise<DesktopState>,
  stopRun: () => ipcRenderer.invoke("factory:stop-run") as Promise<DesktopState>,
  refreshReadiness: () => ipcRenderer.invoke("factory:refresh-readiness") as Promise<DesktopState>,
  promptCredential: (name) => ipcRenderer.invoke("factory:prompt-credential", name) as Promise<DesktopState>,
  removeCredential: (name) => ipcRenderer.invoke("factory:remove-credential", name) as Promise<DesktopState>,
  getArtifactText: (id) => ipcRenderer.invoke("factory:get-artifact-text", id),
  openArtifact: (id) => ipcRenderer.invoke("factory:open-artifact", id),
  exportReplay: (bundle: AnyReplayBundle) => ipcRenderer.invoke("factory:export-replay", bundle) as Promise<{ saved: boolean; path?: string }>,
  onState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopState) => listener(state);
    ipcRenderer.on("factory:state", handler);
    return () => ipcRenderer.removeListener("factory:state", handler);
  },
  onSnapshot: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: FactorySnapshot) => listener(snapshot);
    ipcRenderer.on("factory:snapshot", handler);
    return () => ipcRenderer.removeListener("factory:snapshot", handler);
  },
  onProjectSnapshot: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: ProjectSnapshot) => listener(snapshot);
    ipcRenderer.on("factory:project-snapshot", handler);
    return () => ipcRenderer.removeListener("factory:project-snapshot", handler);
  },
};

contextBridge.exposeInMainWorld("gamefactoryDesktop", Object.freeze(api));

window.addEventListener("DOMContentLoaded", () => {
  window.setTimeout(() => {
    ipcRenderer.send("factory:renderer-ready", {
      title: document.title,
      text: document.body.innerText.slice(0, 4_000),
    });
  }, 900);
}, { once: true });
