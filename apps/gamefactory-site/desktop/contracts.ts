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
  readiness?: {
    status: "checking" | "ready" | "issues";
    checkedAt?: string;
    checks: Array<{ capability: string; ok: boolean; message: string }>;
  };
  credentials?: string[];
}

export interface DesktopArtifactText {
  id: string;
  label: string;
  mediaType: string;
  text: string;
}

export interface DesktopFactoryApi {
  getState(): Promise<DesktopState>;
  getSnapshot(runId?: string): Promise<FactorySnapshot | undefined>;
  chooseCampaign(): Promise<DesktopState>;
  startRun(): Promise<DesktopState>;
  stopRun(): Promise<DesktopState>;
  refreshReadiness(): Promise<DesktopState>;
  promptCredential(name: string): Promise<DesktopState>;
  removeCredential(name: string): Promise<DesktopState>;
  getArtifactText(id: string): Promise<DesktopArtifactText>;
  openArtifact(id: string): Promise<{ opened: boolean; error?: string }>;
  exportReplay(bundle: ReplayBundle): Promise<{ saved: boolean; path?: string }>;
  onState(listener: (state: DesktopState) => void): () => void;
  onSnapshot(listener: (snapshot: FactorySnapshot) => void): () => void;
}

declare global {
  interface Window {
    gamefactoryDesktop?: DesktopFactoryApi;
  }
}
