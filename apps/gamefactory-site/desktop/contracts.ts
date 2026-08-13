import type { FactorySnapshot, ReplayBundle } from "../lib/types";

export type DesktopRunStatus = "idle" | "watching" | "running" | "stopping" | "complete" | "error";

export interface DesktopSelection {
  campaignPath: string;
  configPath: string;
  factoryRoot: string;
  projectRoot: string;
  campaignId: string;
  objective: string;
}

export interface DesktopState {
  status: DesktopRunStatus;
  running: boolean;
  selection?: DesktopSelection;
  message: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface DesktopFactoryApi {
  getState(): Promise<DesktopState>;
  getSnapshot(runId?: string): Promise<FactorySnapshot | undefined>;
  chooseCampaign(): Promise<DesktopState>;
  startRun(): Promise<DesktopState>;
  stopRun(): Promise<DesktopState>;
  exportReplay(bundle: ReplayBundle): Promise<{ saved: boolean; path?: string }>;
  onState(listener: (state: DesktopState) => void): () => void;
  onSnapshot(listener: (snapshot: FactorySnapshot) => void): () => void;
}

declare global {
  interface Window {
    gamefactoryDesktop?: DesktopFactoryApi;
  }
}
