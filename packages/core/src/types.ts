import type {
  JournalJsonValue,
  WorkflowJournalAppend,
  WorkflowJournalEntry,
  WorkflowRecoveryState
} from "./journal.js";
import type { TraceSink } from "./trace.js";
import type { InvocationUsage } from "./usage.js";
import type { FailureClass } from "./failures.js";

export type CapabilityKind =
  | "workspace"
  | "agent"
  | "engine"
  | "scenario"
  | "evaluator"
  | "intake"
  | "workflow"
  | "reporter"
  | "policy";

export type ArtifactKind =
  | "image"
  | "video"
  | "audio"
  | "replay"
  | "telemetry"
  | "profile"
  | "test-report"
  | "log"
  | "build"
  | "crash-dump"
  | "other";

export interface ArtifactReference {
  kind: ArtifactKind;
  path: string;
  mediaType?: string;
  label?: string;
  sha256?: string;
  metadata?: Record<string, unknown>;
}

export interface Violation {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  location?: string;
  /** Optional graph writer ids causally responsible for this violation. */
  causalNodeIds?: string[];
}

export interface Evaluation {
  evaluator: string;
  version: string;
  status: "pass" | "fail" | "inconclusive";
  metrics: Record<string, number>;
  violations: Violation[];
  artifacts: ArtifactReference[];
  confidence?: number;
  summary?: string;
  usage?: InvocationUsage;
  /** Separates evaluator availability from an honest candidate verdict. */
  failureClass?: FailureClass;
}

export interface BudgetConfig {
  wallTimeMinutes?: number;
  maximumExperiments?: number;
  maximumConsecutiveCrashes?: number;
  plateauExperiments?: number;
  maximumCostUsd?: number;
}

export interface AcceptanceConfig {
  primaryMetric: string;
  direction: "minimize" | "maximize";
  minimumDelta?: number;
  /** Whether meeting the threshold exactly is sufficient. Defaults to strict improvement. */
  comparison?: "strict" | "at-least";
  hardGates?: string[];
  allowRegressions?: boolean;
}

export interface Campaign {
  apiVersion: "gamefactory.dev/v1";
  id: string;
  objective: string;
  projectRoot: string;
  workflow: string;
  requires: string[];
  optional?: string[];
  mutablePaths?: string[];
  immutablePaths?: string[];
  parameters?: Record<string, unknown>;
  acceptance: AcceptanceConfig;
  budget?: BudgetConfig;
  humanGates?: string[];
}

export interface Candidate {
  id: string;
  root: string;
  baseRevision?: string;
  metadata: Record<string, unknown>;
}

export interface WorkspaceDriver {
  id: string;
  createCandidate(input: {
    campaign: Campaign;
    experimentId: string;
    signal: AbortSignal;
    runtime?: FactoryRuntimeContext;
  }): Promise<Candidate>;
  acceptCandidate(input: {
    campaign: Campaign;
    candidate: Candidate;
    signal: AbortSignal;
    /** Stable identity used to make a retried acceptance idempotent. */
    operationId?: string;
  }): Promise<{ revision?: string; candidateRevision?: string; changed?: boolean }>;
  discardCandidate(input: {
    campaign: Campaign;
    candidate: Candidate;
    signal: AbortSignal;
    /** Stable identity used to associate cleanup with a durable decision. */
    operationId?: string;
  }): Promise<void>;
}

export interface FactoryRuntimeContext {
  dataRoot?: string;
  worktreeRoot?: string;
  /** Hash of the activated orchestration/runtime implementation for durable reuse. */
  implementationFingerprint?: string;
}

export interface AgentInvocationInput {
  contributorId: string;
  nodeId: string;
  role: AgentRole;
  attempt: number;
  outcome: string;
  summary: string;
  structured?: Record<string, unknown>;
  artifacts: ArtifactReference[];
}

export interface AgentInvocationContext {
  nodeId: string;
  attempt: number;
  instructions: string;
  reason: {
    kind: "initial" | "retry" | "repair" | "review" | "advisor";
    source?: string;
    repairAttempt?: number;
  };
  inputs: AgentInvocationInput[];
}

export interface AgentRequest {
  campaign: Campaign;
  candidate: Candidate;
  experimentId: string;
  /** Stable experiment lineage shared by infrastructure-recovery attempts. */
  logicalExperimentId?: string;
  /** One-based attempt within the logical experiment lineage. */
  attemptNumber?: number;
  /** Concrete prior attempt that retained this candidate for infrastructure recovery. */
  resumedFromExperimentId?: string;
  history: ExperimentRecord[];
  runtime?: FactoryRuntimeContext;
  signal: AbortSignal;
  trace?: TraceSink;
  /** Provider-neutral graph handoff supplied when an orchestration adapter invokes this driver. */
  invocation?: AgentInvocationContext;
}

export interface AgentResult {
  summary: string;
  usage?: InvocationUsage;
  artifacts?: ArtifactReference[];
  contributors?: AgentContribution[];
  metadata?: Record<string, unknown>;
}

export type AgentRole = "scout" | "planner" | "implementer" | "critic" | "judge" | "worker";

export interface AgentContribution {
  agentId: string;
  role: AgentRole;
  status: "complete" | "failed" | "skipped";
  startedAt: string;
  finishedAt: string;
  summary: string;
  artifacts: ArtifactReference[];
  invocationId?: string;
  parentInvocationId?: string;
  usage?: AgentResult["usage"];
  metadata?: Record<string, unknown>;
}

export interface AgentDriver {
  id: string;
  /** Candidate-relative paths the driver may generate as a factory-owned side effect. */
  readonly writePaths?: readonly string[];
  run(request: AgentRequest): Promise<AgentResult>;
  /**
   * Finalizes durable work only after the enclosing workflow has made its
   * acceptance decision. Drivers that checkpoint intermediate work must keep
   * it provisional until this hook is called. Implementations must be
   * idempotent for an identical experiment, candidate, result, and decision:
   * recovery may repeat a finalization whose completion was not journaled.
   */
  finalize?(request: AgentRequest & {
    result: AgentResult;
    evaluations: Evaluation[];
    accepted: boolean;
    reason: string;
  }): Promise<void>;
}

export interface EngineDriver {
  id: string;
  doctor(context: ProjectContext): Promise<DoctorResult>;
  build?(context: CandidateContext): Promise<ExecutionResult>;
  exportBuild?(context: CandidateContext): Promise<ExecutionResult>;
}

export interface ScenarioReference {
  provider: string;
  version: string;
  path: string;
  parameters?: Record<string, unknown>;
}

export interface ScenarioRunner {
  id: string;
  run(input: CandidateContext & { scenario: ScenarioReference }): Promise<ScenarioResult>;
}

export interface ScenarioResult {
  status: "pass" | "fail" | "crash";
  metrics: Record<string, number>;
  artifacts: ArtifactReference[];
  violations: Violation[];
  metadata?: Record<string, unknown>;
}

export interface Evaluator {
  id: string;
  version: string;
  evaluate(input: EvaluationRequest): Promise<Evaluation>;
}

export interface IntakeOption {
  id: string;
  label: string;
  description: string;
  delegates?: boolean;
}

export interface IntakeQuestion {
  id: string;
  prompt: string;
  whyItMatters: string;
  options: IntakeOption[];
}

export interface IntakeAnswer {
  questionId: string;
  optionId: string;
  label: string;
  delegated: boolean;
}

export interface IntakeRequest {
  brief: string;
  projectRoot: string;
  signal: AbortSignal;
  ask(question: IntakeQuestion): Promise<IntakeOption>;
}

export interface IntakeResult {
  apiVersion: string;
  provider: string;
  summary: string;
  answers: IntakeAnswer[];
  document: Record<string, unknown>;
}

export interface IntakeDriver {
  id: string;
  run(request: IntakeRequest): Promise<IntakeResult>;
}

export interface EvaluationRequest {
  campaign: Campaign;
  candidate: Candidate | null;
  experimentId: string;
  priorEvaluations: Evaluation[];
  signal: AbortSignal;
}

export interface Workflow {
  id: string;
  run(context: WorkflowContext): Promise<CampaignResult>;
}

export interface Reporter {
  id: string;
  onEvent(event: FactoryEvent): Promise<void> | void;
}

export interface Policy {
  id: string;
  check(input: PolicyInput): Promise<PolicyDecision> | PolicyDecision;
}

export interface PolicyInput {
  action: string;
  campaign: Campaign;
  candidate?: Candidate;
  details?: Record<string, unknown>;
}

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
  requireHuman?: boolean;
}

export interface ProjectContext {
  campaign: Campaign;
  projectRoot: string;
  signal: AbortSignal;
}

export interface CandidateContext extends ProjectContext {
  candidate: Candidate;
  experimentId: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; message: string }>;
}

export interface ExecutionResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  artifacts: ArtifactReference[];
  metrics?: Record<string, number>;
}

export interface ExperimentRecord {
  campaignId: string;
  runId?: string;
  experimentId: string;
  startedAt: string;
  finishedAt: string;
  status: "baseline" | "keep" | "discard" | "crash" | "blocked" | "cancelled";
  candidateId?: string;
  revision?: string;
  summary: string;
  metrics: Record<string, number>;
  evaluations: Evaluation[];
  agent?: {
    summary: string;
    contributors: AgentContribution[];
    artifacts: ArtifactReference[];
  };
  usage?: AgentResult["usage"];
  metadata?: Record<string, unknown>;
}

export interface CampaignResult {
  campaignId: string;
  status: "complete" | "budget-exhausted" | "blocked" | "cancelled" | "failed";
  startedAt: string;
  finishedAt: string;
  experiments: ExperimentRecord[];
  bestMetrics: Record<string, number>;
  summary: string;
}

export type FactoryEvent =
  | { type: "campaign:start"; campaign: Campaign; at: string }
  | { type: "campaign:finish"; result: CampaignResult; at: string }
  | { type: "experiment:start"; campaignId: string; experimentId: string; at: string }
  | { type: "experiment:finish"; record: ExperimentRecord; at: string }
  | { type: "extension:activate"; extension: string; at: string }
  | { type: "extension:error"; extension: string; error: string; at: string };

export interface WorkflowContext {
  campaign: Campaign;
  runtime?: FactoryRuntimeContext;
  signal: AbortSignal;
  startedAt: string;
  get<T>(kind: CapabilityKind, id: string): T;
  getAll<T>(kind: CapabilityKind): T[];
  appendRecord(record: ExperimentRecord): Promise<void>;
  readRecords(): Promise<ExperimentRecord[]>;
  preserveArtifacts(artifacts: ArtifactReference[], namespace: string): Promise<ArtifactReference[]>;
  journal?: WorkflowJournalContext;
  trace?: TraceSink;
  emit(event: FactoryEvent): Promise<void>;
  budget: BudgetControllerLike;
  logger: Logger;
}

export interface WorkflowJournalContext {
  readonly runId: string;
  readonly fingerprints: Readonly<Record<string, string>>;
  append(input: Omit<WorkflowJournalAppend, "runId" | "campaignId" | "fingerprints"> & {
    data?: JournalJsonValue;
  }): Promise<WorkflowJournalEntry>;
  appendRecovered(input: WorkflowJournalAppend): Promise<WorkflowJournalEntry>;
  recover(): Promise<WorkflowRecoveryState>;
}

export interface BudgetControllerLike {
  readonly experiments: number;
  readonly consecutiveCrashes: number;
  readonly experimentsWithoutImprovement: number;
  readonly costUsd: number;
  canStart(requestedExperiments?: number): { allowed: boolean; reason?: string };
  remainingExperiments(): number;
  tryReserve(input: { experimentId: string; estimatedCostUsd?: number }): BudgetReservationLike | undefined;
  record(input: { status: ExperimentRecord["status"]; costUsd?: number }): void;
  elapsedMs(): number;
}

export interface BudgetReservationLike {
  readonly experimentId: string;
  readonly settled: boolean;
  settle(input: { status: ExperimentRecord["status"]; actualCostUsd?: number }): void;
  cancel(): void;
}

export interface Logger {
  debug(message: string, details?: Record<string, unknown>): void;
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export interface ExtensionManifest {
  name: string;
  version: string;
  apiVersion: string;
  entry: string;
  activation: string[];
  contributes: Partial<Record<CapabilityKind, string[]>>;
  requires?: string[];
  permissions?: string[];
  description?: string;
}

export interface ExtensionDescriptor {
  root: string;
  manifestPath: string;
  manifestSha256: string;
  manifest: ExtensionManifest;
}

export interface ActiveExtension {
  name: string;
  version: string;
  activatedAt: string;
  capabilities: string[];
  activation: string[];
  manifestSha256: string;
  permissions: string[];
  description?: string;
}

export interface Disposable {
  dispose(): Promise<void> | void;
}

export interface FactoryExtension {
  activate(api: FactoryAPI): Promise<Disposable | void> | Disposable | void;
}

export interface FactoryAPI {
  readonly extensionName: string;
  get<T>(kind: CapabilityKind, id: string): T;
  register<T>(kind: CapabilityKind, id: string, value: T): Disposable;
  onEvent(handler: (event: FactoryEvent) => Promise<void> | void): Disposable;
  log: Logger;
}

export interface FactoryConfig {
  apiVersion: "gamefactory.dev/v1";
  extensions: string[];
  artifactDirectory?: string;
  resultLog?: string;
  journalLog?: string;
  traceLog?: string;
}
