import type { AnyReplayBundle, FactorySnapshot, ProjectReplayBundle, ProjectSnapshot } from "../lib/types";

export type DesktopRunStatus = "idle" | "watching" | "running" | "stopping" | "complete" | "error";

export interface DesktopSelection {
  kind?: "campaign" | "project";
  projectPath?: string;
  projectId?: string;
  projectTitle?: string;
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
  getProjectSnapshot(selection?: { phaseId?: string; attemptId?: string; runId?: string }): Promise<ProjectSnapshot | undefined>;
  getProjectReplay(): Promise<ProjectReplayBundle | undefined>;
  chooseCampaign(): Promise<DesktopState>;
  chooseProject(): Promise<DesktopState>;
  startRun(): Promise<DesktopState>;
  stopRun(): Promise<DesktopState>;
  refreshReadiness(): Promise<DesktopState>;
  promptCredential(name: string): Promise<DesktopState>;
  removeCredential(name: string): Promise<DesktopState>;
  getArtifactText(id: string): Promise<DesktopArtifactText>;
  openArtifact(id: string): Promise<{ opened: boolean; error?: string }>;
  exportReplay(bundle: AnyReplayBundle): Promise<{ saved: boolean; path?: string }>;
  onState(listener: (state: DesktopState) => void): () => void;
  onSnapshot(listener: (snapshot: FactorySnapshot) => void): () => void;
  onProjectSnapshot(listener: (snapshot: ProjectSnapshot) => void): () => void;
}

declare global {
  interface Window {
    gamefactoryDesktop?: DesktopFactoryApi;
  }
}
