import type { ArtifactReference, CampaignResult, JournalJsonValue } from "@gamefactory/core";

export interface ProjectMetricGate {
  minimum?: number;
  maximum?: number;
}

export interface ProjectPhaseGate {
  requireAcceptedRevision?: boolean;
  requireMetrics?: Record<string, ProjectMetricGate>;
  requireHumanApproval?: boolean;
}

export interface ProjectPhaseAttempt {
  id: string;
  campaign: string;
  config: string;
  status?: "active" | "superseded" | "archived";
}

export interface ProjectPhase {
  id: string;
  title: string;
  order: number;
  dependsOn?: string[];
  gate?: ProjectPhaseGate;
  attempts: ProjectPhaseAttempt[];
}

export interface GameFactoryProject {
  apiVersion: "gamefactory.dev/v1";
  kind: "Project";
  id: string;
  title: string;
  projectRoot: string;
  phases: ProjectPhase[];
}

export interface LoadedProjectPhaseAttempt extends ProjectPhaseAttempt {
  campaignPath: string;
  configPath: string;
}

export interface LoadedProjectPhase extends Omit<ProjectPhase, "attempts"> {
  attempts: LoadedProjectPhaseAttempt[];
}

export interface LoadedGameFactoryProject extends Omit<GameFactoryProject, "phases"> {
  manifestPath: string;
  root: string;
  phases: LoadedProjectPhase[];
}

export type ProjectJourneyEventType =
  | "project-started"
  | "project-finished"
  | "project-blocked"
  | "project-paused"
  | "phase-started"
  | "phase-completed"
  | "phase-blocked"
  | "phase-superseded"
  | "campaign-linked"
  | "review-started"
  | "review-completed"
  | "candidate-recovered"
  | "promotion-intent"
  | "promotion-applied";

export interface ProjectActor {
  kind: "factory" | "agent" | "user" | "system";
  id?: string;
}

export interface ProjectJourneyAppend {
  projectId: string;
  projectRunId: string;
  type: ProjectJourneyEventType;
  idempotencyKey: string;
  manifestFingerprint: string;
  phaseId?: string;
  phaseAttemptId?: string;
  campaignId?: string;
  runId?: string;
  experimentId?: string;
  candidateId?: string;
  actor: ProjectActor;
  sourceRevision?: string;
  resultingRevision?: string;
  artifacts?: ArtifactReference[];
  data?: JournalJsonValue;
}

export interface ProjectJourneyEvent extends ProjectJourneyAppend {
  version: 1;
  sequence: number;
  timestamp: string;
}

export interface ProjectRunResult {
  projectId: string;
  projectRunId: string;
  status: "complete" | "blocked" | "cancelled" | "failed";
  startedAt: string;
  finishedAt: string;
  phases: Array<{
    phaseId: string;
    attemptId: string;
    status: "complete" | "blocked";
    campaignResult?: CampaignResult;
    reasons?: string[];
    acceptedRevision?: string;
  }>;
}
