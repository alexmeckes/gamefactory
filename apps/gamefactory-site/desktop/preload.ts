import { contextBridge, ipcRenderer } from "electron";
import type { DesktopFactoryApi, DesktopState } from "./contracts";
import type { FactorySnapshot, ReplayBundle } from "../lib/types";

const api: DesktopFactoryApi = {
  getState: () => ipcRenderer.invoke("factory:get-state") as Promise<DesktopState>,
  getSnapshot: (runId?: string) => ipcRenderer.invoke("factory:get-snapshot", runId) as Promise<FactorySnapshot | undefined>,
  chooseCampaign: () => ipcRenderer.invoke("factory:choose-campaign") as Promise<DesktopState>,
  startRun: () => ipcRenderer.invoke("factory:start-run") as Promise<DesktopState>,
  stopRun: () => ipcRenderer.invoke("factory:stop-run") as Promise<DesktopState>,
  exportReplay: (bundle: ReplayBundle) => ipcRenderer.invoke("factory:export-replay", bundle) as Promise<{ saved: boolean; path?: string }>,
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
