import type { ArtifactReference, CampaignResult, JournalJsonValue } from "@gamefactory/core";

export interface ProjectMetricGate {
  minimum?: number;
  maximum?: number;
}

export interface ProjectPhaseGate {
  requireAcceptedRevision?: boolean;
  requireMetrics?: Record<string, ProjectMetricGate>;
  requireHumanApproval?: boolean;
  allowBudgetExhaustedAfterAcceptance?: boolean;
}

export interface ProjectPhaseAttempt {
  id: string;
  campaign: string;
  config: string;
  status?: "active" | "superseded" | "archived";
}

export type ProjectWorkKind = "legacy-phase" | "spec-convergence" | "vertical-slice";

export interface ProjectAttemptPolicy {
  executionRetries?: number;
  creativeRepairs?: number;
  specAmendments?: number;
  advisorEscalations?: number;
}

/** A slice may request this return edge only from preserved runtime evidence. */
export interface ProjectSpecAmendmentRequest {
  kind: "spec-amendment";
  rationale: string;
  claimIds: string[];
  evidenceArtifactSha256: string[];
}

export interface ProjectEvidenceGate {
  scenarios?: string[];
  requireInteractionTrace?: boolean;
  requireEngineCapture?: boolean;
  requireMotionEvidence?: boolean;
  requireRuntimeAssets?: string[];
  /** Agent graph node whose in-memory, read-only verdict must approve the target hash. */
  targetApprovalNode?: string;
}

export interface ProjectSpecStage {
  id?: string;
  title?: string;
  concept: string;
  spec: string;
  maximumConvergencePasses?: number;
  /** @deprecated Use maximumConvergencePasses. This never limits the lifetime GameSpec revision number. */
  maximumRevisions?: number;
  gate?: ProjectPhaseGate;
  attempts: ProjectPhaseAttempt[];
}

export interface ProjectSlice {
  id: string;
  title: string;
  order: number;
  dependsOn?: string[];
  consumesClaims: string[];
  playerOutcome: string;
  primaryRisk: string;
  nonGoals?: string[];
  mutablePaths?: string[];
  evidence?: ProjectEvidenceGate;
  attemptPolicy?: ProjectAttemptPolicy;
  gate?: ProjectPhaseGate;
  attempts: ProjectPhaseAttempt[];
}

export interface ProjectPhase {
  id: string;
  title: string;
  order: number;
  dependsOn?: string[];
  gate?: ProjectPhaseGate;
  attempts: ProjectPhaseAttempt[];
  workKind?: ProjectWorkKind;
  consumesClaims?: string[];
  playerOutcome?: string;
  primaryRisk?: string;
  nonGoals?: string[];
  mutablePaths?: string[];
  evidence?: ProjectEvidenceGate;
  attemptPolicy?: ProjectAttemptPolicy;
}

export interface GameFactoryProjectV1 {
  apiVersion: "gamefactory.dev/v1";
  kind: "Project";
  id: string;
  title: string;
  projectRoot: string;
  history?: string;
  phases: ProjectPhase[];
}

export interface GameFactoryProjectV2 {
  apiVersion: "gamefactory.dev/v2";
  kind: "Project";
  id: string;
  title: string;
  projectRoot: string;
  history?: string;
  preproduction: ProjectSpecStage;
  slices: ProjectSlice[];
}

export type GameFactoryProject = GameFactoryProjectV1 | GameFactoryProjectV2;

export type GameSpecClaimCategory = "player" | "world" | "interaction" | "loop" | "system" | "experience" | "visual" | "motion" | "technical" | "content" | "exclusion" | "other";
export type GameSpecClaimStatus = "required" | "assumption" | "open";

export interface GameSpecClaim {
  id: string;
  category: GameSpecClaimCategory;
  statement: string;
  status: GameSpecClaimStatus;
  falsifiers?: string[];
}

export interface GameSpecDecision {
  id: string;
  status: "accepted" | "rejected" | "deferred";
  question: string;
  resolution: string;
  affectedClaims?: string[];
}

export interface GameSpecSlicePlan {
  id: string;
  playerOutcome: string;
  primaryRisk: string;
  claimIds: string[];
}

export interface GameSpecChange {
  kind: "initial" | "evidence-amendment" | "user-amendment";
  rationale: string;
  evidence?: string[];
  affectedClaims?: string[];
  affectedSlices?: string[];
}

export interface GameSpec {
  apiVersion: "gamefactory.game-spec/v1";
  kind: "GameSpec";
  projectId: string;
  revision: number;
  status: "draft" | "frozen";
  concept: string;
  thesis: string;
  claims: GameSpecClaim[];
  decisions?: GameSpecDecision[];
  slices: GameSpecSlicePlan[];
  assumptions?: string[];
  openQuestions?: string[];
  supersedes?: { revision: number; sha256: string };
  change?: GameSpecChange;
}

export interface LoadedProjectPhaseAttempt extends ProjectPhaseAttempt {
  campaignPath: string;
  configPath: string;
}

export interface LoadedProjectPhase extends Omit<ProjectPhase, "attempts"> {
  attempts: LoadedProjectPhaseAttempt[];
}

export interface LoadedGameFactoryProject {
  apiVersion: GameFactoryProject["apiVersion"];
  kind: "Project";
  id: string;
  title: string;
  projectRoot: string;
  history?: string;
  manifestPath: string;
  root: string;
  historyPath?: string;
  phases: LoadedProjectPhase[];
  preproduction?: Omit<ProjectSpecStage, "attempts"> & { conceptPath: string; specPath: string; attempts: LoadedProjectPhaseAttempt[] };
  slices?: Array<Omit<ProjectSlice, "attempts"> & { attempts: LoadedProjectPhaseAttempt[] }>;
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
  | "promotion-applied"
  | "spec-started"
  | "spec-frozen"
  | "spec-blocked"
  | "slice-started"
  | "slice-completed"
  | "slice-blocked"
  | "slice-invalidated";

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
  workKind?: ProjectWorkKind;
  unitFingerprint?: string;
  specRevision?: number;
  specFingerprint?: string;
  consumedClaims?: string[];
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
    workKind?: ProjectWorkKind;
    unitFingerprint?: string;
    reused?: boolean;
  }>;
}
