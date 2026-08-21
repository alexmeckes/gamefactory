import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { FactoryRunner, loadCampaign, loadFactoryConfig, resolveCampaignRunIdentity, resolveFactoryStatePath, type Campaign, type CampaignResult, type FactoryConfig, type FactoryTraceEvent, type JournalJsonValue, type Logger } from "@gamefactory/core";
import { acquireProjectLease, ProjectJourneyJournal, type ProjectJourneyIndex } from "./journal.js";
import { projectManifestFingerprint } from "./manifest.js";
import { gameSpecFingerprint, loadGameSpec } from "./spec.js";
import type { GameFactoryProject, GameSpec, LoadedGameFactoryProject, LoadedProjectPhase, LoadedProjectPhaseAttempt, ProjectJourneyEvent, ProjectRunResult, ProjectSpecAmendmentRequest } from "./types.js";

const execFileAsync = promisify(execFile);

export interface ProjectCampaignExecution {
  campaign: Campaign;
  config: FactoryConfig;
  campaignResult: CampaignResult;
  runId: string;
}

export interface ProjectRunnerOptions {
  cwd: string;
  dataRoot?: string;
  worktreeRoot?: string;
  onTraceEvent?: (event: FactoryTraceEvent) => Promise<void> | void;
  journeyIndex?: ProjectJourneyIndex;
  logger: Logger;
  signal?: AbortSignal;
  executeCampaign?: (input: { campaign: Campaign; config: FactoryConfig; signal: AbortSignal }) => Promise<CampaignResult>;
}

async function gitRevision(root: string): Promise<string | undefined> {
  try {
    const { stdout: revision } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], { windowsHide: true });
    const { stdout: status } = await execFileAsync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { windowsHide: true });
    if (status.trim()) throw new Error("Project repository is dirty; commit or stash changes before advancing the project.");
    return revision.trim();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Project repository is dirty")) throw error;
    return undefined;
  }
}

function rawProject(project: LoadedGameFactoryProject): GameFactoryProject {
  const attempts = (values: LoadedProjectPhaseAttempt[]) => values.map(({ campaignPath: _campaignPath, configPath: _configPath, ...attempt }) => attempt);
  if (project.apiVersion === "gamefactory.dev/v2") {
    if (!project.preproduction || !project.slices) throw new Error("Loaded v2 project is missing preproduction or slices");
    const { conceptPath: _conceptPath, specPath: _specPath, attempts: specAttempts, ...preproduction } = project.preproduction;
    return {
      apiVersion: "gamefactory.dev/v2", kind: project.kind, id: project.id, title: project.title, projectRoot: project.projectRoot,
      ...(project.history ? { history: project.history } : {}),
      preproduction: { ...preproduction, attempts: attempts(specAttempts) },
      slices: project.slices.map(({ attempts: sliceAttempts, ...slice }) => ({ ...slice, attempts: attempts(sliceAttempts) }))
    };
  }
  return { apiVersion: "gamefactory.dev/v1", kind: project.kind, id: project.id, title: project.title, projectRoot: project.projectRoot, ...(project.history ? { history: project.history } : {}), phases: project.phases.map(({ attempts: phaseAttempts, workKind: _workKind, ...phase }) => ({ ...phase, attempts: attempts(phaseAttempts) })) };
}

function activeAttempt(phase: LoadedProjectPhase): LoadedProjectPhaseAttempt {
  return phase.attempts.find((item) => (item.status ?? "active") === "active")!;
}

function projectPath(project: LoadedGameFactoryProject, path: string): string {
  return relative(project.root, path).replaceAll("\\", "/");
}

function patternContains(parent: string, child: string): boolean {
  const outer = parent.replaceAll("\\", "/").replace(/^\.\//, "");
  const inner = child.replaceAll("\\", "/").replace(/^\.\//, "");
  if (outer === "**" || outer === inner) return true;
  if (!outer.endsWith("/**")) return false;
  const prefix = outer.slice(0, -3).replace(/\/$/, "");
  return inner === prefix || inner.startsWith(`${prefix}/`);
}

function campaignForPhase(campaign: Campaign, phase: LoadedProjectPhase, project: LoadedGameFactoryProject, amendment?: ProjectSpecAmendmentRequest, frozenSpec?: { spec: GameSpec; fingerprint: string }): Campaign {
  if (phase.workKind === "spec-convergence") {
    const passes = project.preproduction?.maximumConvergencePasses ?? project.preproduction?.maximumRevisions ?? 3;
    return {
      ...campaign,
      budget: { ...campaign.budget, maximumExperiments: Math.min(campaign.budget?.maximumExperiments ?? passes, passes) },
      parameters: {
        ...campaign.parameters,
        projectSpec: {
          projectId: project.id,
          conceptPath: projectPath(project, project.preproduction!.conceptPath),
          specPath: projectPath(project, project.preproduction!.specPath),
          maximumConvergencePasses: passes,
          ...(amendment ? { amendment } : {})
        }
      }
    };
  }
  if (phase.workKind !== "vertical-slice") return campaign;
  if (!phase.mutablePaths?.length) throw new Error(`Project slice ${phase.id} must declare mutablePaths so its authority can be enforced`);
  if (campaign.mutablePaths?.length) {
    const outside = phase.mutablePaths.filter((path) => !campaign.mutablePaths!.some((parent) => patternContains(parent, path)));
    if (outside.length) throw new Error(`Project slice ${phase.id} expands campaign mutation authority: ${outside.join(", ")}`);
  }
  const manifestRelative = projectPath(project, project.manifestPath);
  const immutablePaths = [...new Set([
    ...(campaign.immutablePaths ?? []),
    ...(!manifestRelative.startsWith("../") && manifestRelative !== ".." ? [manifestRelative] : []),
    ...(project.preproduction ? [projectPath(project, project.preproduction.conceptPath), projectPath(project, project.preproduction.specPath)] : [])
  ])];
  // Promotion policy belongs to the project runner, not the campaign execution
  // contract. Keeping it out of projectSlice lets a completed bounded campaign
  // be re-evaluated under a corrected promotion policy without invalidating its
  // run identity and replaying expensive agent/evaluator work.
  const { allowBudgetExhaustedAfterAcceptance: _allowBudgetExhaustedAfterAcceptance, ...executionGate } = phase.gate ?? {};
  const sliceContract = {
    projectId: project.id,
    sliceId: phase.id,
    title: phase.title,
    claimIds: phase.consumesClaims ?? [],
    playerOutcome: phase.playerOutcome,
    primaryRisk: phase.primaryRisk,
    nonGoals: phase.nonGoals ?? [],
    mutablePaths: phase.mutablePaths,
    evidence: phase.evidence ?? {},
    gate: executionGate,
    attemptPolicy: phase.attemptPolicy ?? {},
    ...(frozenSpec ? { specRevision: frozenSpec.spec.revision, specFingerprint: frozenSpec.fingerprint } : {})
  };
  const agentTeam = campaign.parameters?.agentTeam;
  const graph = agentTeam && typeof agentTeam === "object" && !Array.isArray(agentTeam) ? (agentTeam as Record<string, unknown>).graph : undefined;
  const graphRecord = graph && typeof graph === "object" && !Array.isArray(graph) ? graph as Record<string, unknown> : undefined;
  const existingPolicy = graphRecord?.attemptPolicy;
  const policy = existingPolicy && typeof existingPolicy === "object" && !Array.isArray(existingPolicy) ? existingPolicy as Record<string, unknown> : {};
  const attemptPolicy = phase.attemptPolicy;
  return {
    ...campaign,
    mutablePaths: [...phase.mutablePaths],
    immutablePaths,
    parameters: {
      ...campaign.parameters,
      projectSlice: sliceContract,
      ...(graphRecord ? { agentTeam: {
        ...(agentTeam as Record<string, unknown>),
        graph: {
          ...graphRecord,
          claimIds: phase.consumesClaims ?? [],
          enforceClaimedBlockers: true,
          ...(attemptPolicy ? { attemptPolicy: { ...policy, ...(attemptPolicy.executionRetries !== undefined ? { executionRetries: attemptPolicy.executionRetries } : {}), ...(attemptPolicy.creativeRepairs !== undefined ? { creativeRepairs: attemptPolicy.creativeRepairs } : {}), ...(attemptPolicy.advisorEscalations !== undefined ? { advisorEscalations: attemptPolicy.advisorEscalations } : {}) } } : {})
        }
      } } : {})
    }
  };
}

function gateReasons(phase: LoadedProjectPhase, result: CampaignResult): { reasons: string[]; acceptedRevision?: string } {
  const reasons: string[] = [];
  const accepted = [...result.experiments].reverse().find((record) => record.status === "keep" && record.revision);
  if (phase.gate?.requireAcceptedRevision && !accepted?.revision) reasons.push("Phase requires an accepted revision, but the campaign did not record one.");
  if (phase.gate?.requireHumanApproval) reasons.push("Phase requires human approval before automatic advancement.");
  for (const [metric, bounds] of Object.entries(phase.gate?.requireMetrics ?? {})) {
    const value = result.bestMetrics[metric];
    if (typeof value !== "number") reasons.push(`Required metric ${metric} was not reported.`);
    else {
      if (bounds.minimum !== undefined && value < bounds.minimum) reasons.push(`${metric} ${value} is below ${bounds.minimum}.`);
      if (bounds.maximum !== undefined && value > bounds.maximum) reasons.push(`${metric} ${value} is above ${bounds.maximum}.`);
    }
  }
  if (result.status === "budget-exhausted") {
    if (!phase.gate?.allowBudgetExhaustedAfterAcceptance || !accepted?.revision) reasons.push("Campaign exhausted its budget without an explicit phase policy allowing an already accepted revision to advance.");
  } else if (result.status !== "complete") reasons.push(`Campaign finished with ${result.status}.`);
  return { reasons, ...(accepted?.revision ? { acceptedRevision: accepted.revision } : {}) };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function journalData(value: unknown): JournalJsonValue {
  return JSON.parse(JSON.stringify(value)) as JournalJsonValue;
}

function normalizedText(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

async function campaignSkillFingerprint(campaign: Campaign): Promise<string> {
  const agentTeam = campaign.parameters?.agentTeam;
  const graph = agentTeam && typeof agentTeam === "object" && !Array.isArray(agentTeam) ? (agentTeam as Record<string, unknown>).graph : undefined;
  const nodes = graph && typeof graph === "object" && !Array.isArray(graph) && Array.isArray((graph as Record<string, unknown>).nodes) ? (graph as Record<string, unknown>).nodes as unknown[] : [];
  const names = new Set<string>();
  for (const node of nodes) {
    if (!node || typeof node !== "object" || Array.isArray(node) || !Array.isArray((node as Record<string, unknown>).skills)) continue;
    for (const binding of (node as Record<string, unknown>).skills as unknown[]) {
      const name = typeof binding === "string" ? binding : binding && typeof binding === "object" && !Array.isArray(binding) ? (binding as Record<string, unknown>).name : undefined;
      if (typeof name === "string") names.add(name);
    }
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.agents/skills");
  const entries = await Promise.all([...names].sort().map(async (name) => {
    try { return [name, createHash("sha256").update(await readFile(resolve(root, name, "SKILL.md"), "utf8")).digest("hex")] as const; }
    catch { return [name, "missing"] as const; }
  }));
  return hash(entries);
}

function keptRecord(result: CampaignResult) {
  return [...result.experiments].reverse().find((record) => record.status === "keep");
}

function projectMetadata(record: ReturnType<typeof keptRecord> | CampaignResult["experiments"][number] | undefined, key: "projectEvidence" | "projectDisposition"): unknown {
  const direct = record?.metadata?.[key];
  if (direct !== undefined) return direct;
  const agent = record?.metadata?.agent;
  return agent && typeof agent === "object" && !Array.isArray(agent) ? (agent as Record<string, unknown>)[key] : undefined;
}

function experimentArtifacts(record: CampaignResult["experiments"][number] | undefined) {
  return [...(record?.agent?.artifacts ?? []), ...(record?.evaluations.flatMap((evaluation) => evaluation.artifacts) ?? [])];
}

function recordArtifacts(result: CampaignResult) {
  return experimentArtifacts(keptRecord(result));
}

function trustedFactoryArtifacts(result: CampaignResult) {
  const record = keptRecord(result);
  return [
    ...(record?.evaluations ?? []).flatMap((evaluation) => evaluation.artifacts.map((artifact) => ({ artifact, producer: `evaluator:${evaluation.evaluator}` }))),
    ...(record?.agent?.contributors ?? []).flatMap((contributor) => contributor.metadata?.adapter === "agent-driver" && typeof contributor.metadata.driver === "string"
      ? contributor.artifacts.map((artifact) => ({ artifact, producer: `agent-driver:${String(contributor.metadata!.driver)}` }))
      : [])
  ];
}

function evidenceReference(value: unknown): string | undefined {
  if (typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const sha256 = (value as Record<string, unknown>).artifactSha256 ?? (value as Record<string, unknown>).sha256;
  return typeof sha256 === "string" && /^[a-f0-9]{64}$/.test(sha256) ? sha256 : undefined;
}

function evidenceReasons(phase: LoadedProjectPhase, result: CampaignResult, frozenSpec?: { spec: GameSpec; fingerprint: string }): string[] {
  if (phase.workKind !== "vertical-slice" || !phase.evidence) return [];
  const metadata = projectMetadata(keptRecord(result), "projectEvidence");
  const evidence = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {};
  const artifacts = trustedFactoryArtifacts(result);
  const artifactByHash = new Map(artifacts.filter((entry) => entry.artifact.sha256).map((entry) => [entry.artifact.sha256!, entry]));
  const scenarioEvaluators = new Set(["evaluator:godot.scenario", "agent-driver:godot.evidence"]);
  const captureEvaluators = new Set(["evaluator:godot.scenario", "evaluator:godot.visual", "agent-driver:godot.evidence"]);
  const hasReference = (value: unknown, kinds?: Set<string>, producers?: Set<string>): boolean => {
    const sha256 = evidenceReference(value);
    const entry = sha256 ? artifactByHash.get(sha256) : undefined;
    return Boolean(entry && (!kinds || kinds.has(entry.artifact.kind)) && (!producers || producers.has(entry.producer)));
  };
  const hasVerifiedEmbodiedReference = (value: unknown): boolean => {
    const sha256 = evidenceReference(value);
    const entry = sha256 ? artifactByHash.get(sha256) : undefined;
    return Boolean(
      entry
      && scenarioEvaluators.has(entry.producer)
      && (entry.artifact.kind === "test-report" || entry.artifact.kind === "replay" || entry.artifact.kind === "telemetry")
      && entry.artifact.metadata?.evidenceClass === "embodied-gameplay"
      && entry.artifact.metadata?.verified === true
    );
  };
  const reasons: string[] = [];
  if (!frozenSpec || evidence.specRevision !== frozenSpec.spec.revision || evidence.specFingerprint !== frozenSpec.fingerprint) reasons.push("Slice evidence is not bound to the current frozen GameSpec revision and fingerprint.");
  const scenarioEvidence = new Map<string, unknown>();
  if (Array.isArray(evidence.scenarios)) for (const item of evidence.scenarios) {
    if (item && typeof item === "object" && !Array.isArray(item) && typeof (item as Record<string, unknown>).id === "string") scenarioEvidence.set((item as Record<string, unknown>).id as string, item);
  }
  for (const scenario of phase.evidence.scenarios ?? []) if (!hasReference(scenarioEvidence.get(scenario), new Set(["replay", "telemetry", "test-report", "log"]), scenarioEvaluators)) reasons.push(`Required slice scenario ${scenario} is not linked to a trusted engine scenario artifact.`);
  if (phase.evidence.requireInteractionTrace && !hasReference(evidence.interactionTrace, new Set(["replay", "telemetry"]), scenarioEvaluators)) reasons.push("Slice requires a trusted real interaction trace artifact.");
  const scenarioReferences = [...scenarioEvidence.values()];
  if (phase.evidence.requireEmbodiedGameplay && ![evidence.embodiedGameplay, evidence.interactionTrace, ...scenarioReferences].some(hasVerifiedEmbodiedReference)) reasons.push("Slice requires evaluator-verified embodied gameplay evidence from shipping input through visible motion and spatial consequence.");
  const captureBundle = evidence.engineCapture && typeof evidence.engineCapture === "object" && !Array.isArray(evidence.engineCapture) ? evidence.engineCapture as Record<string, unknown> : undefined;
  const representativeFrames = Array.isArray(captureBundle?.representativeFrames) ? captureBundle.representativeFrames : [];
  if (phase.evidence.requireEngineCapture && ![evidence.engineCapture, ...representativeFrames].some((value) => hasReference(value, new Set(["image", "video"]), captureEvaluators))) reasons.push("Slice requires a trusted current engine capture artifact.");
  if (phase.evidence.targetApprovalNode && !hasReference(evidence.targetSha256, new Set(["image"]), new Set(["evaluator:design.system"]))) reasons.push("Slice engine evidence is not bound to a design-system-verified target image hash.");
  if (phase.evidence.targetApprovalNode) {
    const targetHash = evidenceReference(evidence.targetSha256);
    const approval = keptRecord(result)?.agent?.contributors.find((contributor) => contributor.metadata?.nodeId === phase.evidence!.targetApprovalNode && contributor.status === "complete" && contributor.metadata?.outcome === "pass");
    const structured = approval?.metadata?.structured;
    const findings = structured && typeof structured === "object" && !Array.isArray(structured) ? (structured as Record<string, unknown>).findings : undefined;
    const approvedHash = findings && typeof findings === "object" && !Array.isArray(findings) ? (findings as Record<string, unknown>).selectedTargetSha256 : undefined;
    if (!approval || typeof approvedHash !== "string" || approvedHash !== targetHash) reasons.push(`Scene target hash is not bound to the in-memory pass verdict from ${phase.evidence.targetApprovalNode}.`);
  }
  if (phase.evidence.requireMotionEvidence && ![evidence.motionEvidence, evidence.interactionTrace].some((value) => hasReference(value, new Set(["video", "replay"]), captureEvaluators))) reasons.push("Slice requires trusted current runtime motion evidence.");
  const runtimeEvidence = new Map<string, unknown>();
  if (Array.isArray(evidence.runtimeAssets)) for (const item of evidence.runtimeAssets) {
    if (item && typeof item === "object" && !Array.isArray(item) && typeof (item as Record<string, unknown>).id === "string" && typeof (item as Record<string, unknown>).consumer === "string") runtimeEvidence.set((item as Record<string, unknown>).id as string, item);
  }
  const assetEvaluators = new Set(["evaluator:design.system", "evaluator:pixel-motion.quality", "agent-driver:godot.evidence", "agent-driver:pixel-motion.compile", "agent-driver:sam3.segment", "agent-driver:sam3.track"]);
  for (const asset of phase.evidence.requireRuntimeAssets ?? []) if (!hasReference(runtimeEvidence.get(asset), undefined, assetEvaluators)) reasons.push(`Required runtime asset family ${asset} is not linked to a trusted evaluator artifact and runtime consumer.`);
  const recordAgent = keptRecord(result)?.metadata?.agent;
  const actualWriterGenerations = recordAgent && typeof recordAgent === "object" && !Array.isArray(recordAgent) ? (recordAgent as Record<string, unknown>).writerGenerations : undefined;
  if (actualWriterGenerations && JSON.stringify(evidence.writerGenerations) !== JSON.stringify(actualWriterGenerations)) reasons.push("Slice evidence writer generations do not match the accepted agent execution.");
  return reasons;
}

function specAmendmentRequest(phase: LoadedProjectPhase, result: CampaignResult): ProjectSpecAmendmentRequest | undefined {
  const dispositionRecord = [...result.experiments].reverse().find((record) => projectMetadata(record, "projectDisposition") !== undefined);
  const raw = projectMetadata(dispositionRecord, "projectDisposition");
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || (raw as Record<string, unknown>).kind !== "spec-amendment") return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.rationale !== "string" || !value.rationale.trim()) throw new Error("A spec-amendment disposition must include a rationale");
  const claimIds = Array.isArray(value.claimIds) ? value.claimIds.filter((item): item is string => typeof item === "string") : [];
  if (!claimIds.length || claimIds.length !== (value.claimIds as unknown[] | undefined)?.length) throw new Error("A spec-amendment disposition must cite claimIds");
  const unknown = claimIds.filter((id) => !(phase.consumesClaims ?? []).includes(id));
  if (unknown.length) throw new Error(`Spec amendment cites claims outside slice ${phase.id}: ${unknown.join(", ")}`);
  const evidenceArtifactSha256 = Array.isArray(value.evidenceArtifactSha256) ? value.evidenceArtifactSha256.filter((item): item is string => typeof item === "string" && /^[a-f0-9]{64}$/.test(item)) : [];
  const preserved = new Set(experimentArtifacts(dispositionRecord).map((artifact) => artifact.sha256).filter((item): item is string => Boolean(item)));
  if (!evidenceArtifactSha256.length || evidenceArtifactSha256.some((sha256) => !preserved.has(sha256))) throw new Error("A spec amendment must cite preserved evidence artifacts from this slice run");
  return { kind: "spec-amendment", rationale: value.rationale, claimIds: [...new Set(claimIds)], evidenceArtifactSha256: [...new Set(evidenceArtifactSha256)] };
}

function pendingAmendmentFromJournal(events: ProjectJourneyEvent[], projectRunId: string): { phaseId: string; request: ProjectSpecAmendmentRequest } | undefined {
  const invalidated = [...events].reverse().find((event) => event.projectRunId === projectRunId && event.type === "slice-invalidated" && event.phaseId);
  if (!invalidated?.phaseId) return undefined;
  if (events.some((event) => event.projectRunId === projectRunId && event.type === "spec-frozen" && event.sequence > invalidated.sequence)) return undefined;
  const data = invalidated.data && typeof invalidated.data === "object" && !Array.isArray(invalidated.data) ? invalidated.data as Record<string, unknown> : undefined;
  const amendment = data?.amendment;
  if (!amendment || typeof amendment !== "object" || Array.isArray(amendment) || (amendment as Record<string, unknown>).kind !== "spec-amendment") throw new Error(`Journal event ${invalidated.sequence} contains an invalid pending GameSpec amendment.`);
  return { phaseId: invalidated.phaseId, request: amendment as unknown as ProjectSpecAmendmentRequest };
}

function eventType(phase: LoadedProjectPhase, state: "started" | "complete" | "blocked"): ProjectJourneyEvent["type"] {
  if (phase.workKind === "spec-convergence") return state === "started" ? "spec-started" : state === "complete" ? "spec-frozen" : "spec-blocked";
  if (phase.workKind === "vertical-slice") return state === "started" ? "slice-started" : state === "complete" ? "slice-completed" : "slice-blocked";
  return state === "started" ? "phase-started" : state === "complete" ? "phase-completed" : "phase-blocked";
}

async function validateFrozenSpec(project: LoadedGameFactoryProject): Promise<{ spec: GameSpec; fingerprint: string }> {
  if (!project.preproduction) throw new Error("Project v2 is missing preproduction configuration");
  const [concept, spec] = await Promise.all([readFile(project.preproduction.conceptPath, "utf8"), loadGameSpec(project.preproduction.specPath, project.id)]);
  if (spec.status !== "frozen") throw new Error(`GameSpec revision ${spec.revision} is not frozen`);
  if (normalizedText(spec.concept) !== normalizedText(concept)) throw new Error("Frozen GameSpec does not preserve the supplied concept verbatim");
  return { spec, fingerprint: gameSpecFingerprint(spec) };
}

async function validateSpecLineageAndArchive(input: {
  project: LoadedGameFactoryProject;
  events: ProjectJourneyEvent[];
  dataRoot?: string;
}): Promise<{ spec: GameSpec; fingerprint: string; archivePath: string }> {
  const frozen = await validateFrozenSpec(input.project);
  const previous = [...input.events].reverse().find((event) => event.type === "spec-frozen" && event.specFingerprint && event.specRevision !== undefined);
  if (previous) {
    const data = previous.data && typeof previous.data === "object" && !Array.isArray(previous.data) ? previous.data as Record<string, unknown> : undefined;
    if (typeof data?.specArchivePath === "string") {
      const archived = await loadGameSpec(data.specArchivePath, input.project.id);
      if (archived.revision !== previous.specRevision || gameSpecFingerprint(archived) !== previous.specFingerprint) throw new Error(`Frozen GameSpec archive for revision ${previous.specRevision} no longer matches its journal fingerprint`);
    }
  }
  if (previous && (previous.specFingerprint !== frozen.fingerprint || previous.specRevision !== frozen.spec.revision)) {
    if (!frozen.spec.supersedes || frozen.spec.supersedes.revision !== previous.specRevision || frozen.spec.supersedes.sha256 !== previous.specFingerprint) {
      throw new Error(`GameSpec revision ${frozen.spec.revision} must supersede the latest frozen revision ${previous.specRevision} (${previous.specFingerprint})`);
    }
    if (!frozen.spec.change || frozen.spec.change.kind === "initial") throw new Error(`GameSpec revision ${frozen.spec.revision} must record attributable amendment metadata`);
    if (frozen.spec.change.kind === "evidence-amendment" && !(frozen.spec.change.evidence?.length)) throw new Error(`Evidence amendment revision ${frozen.spec.revision} must cite evidence`);
  } else if (!previous && frozen.spec.revision !== 1) {
    throw new Error(`The first archived GameSpec must be revision 1, found revision ${frozen.spec.revision}`);
  } else if (!previous && frozen.spec.change?.kind !== "initial") {
    throw new Error("The first archived GameSpec must record initial change metadata");
  }
  const logical = join(".factory", "projects", input.project.id, "specs", `r${String(frozen.spec.revision).padStart(4, "0")}-${frozen.fingerprint}.json`);
  const archivePath = resolveFactoryStatePath({ cwd: input.project.root, ...(input.dataRoot ? { dataRoot: input.dataRoot } : {}) }, logical, logical, "frozen GameSpec archive");
  const source = await readFile(input.project.preproduction!.specPath, "utf8");
  await mkdir(dirname(archivePath), { recursive: true });
  try { await writeFile(archivePath, source, { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await readFile(archivePath, "utf8")) !== source) throw new Error(`Frozen GameSpec archive conflicts at ${archivePath}`);
  }
  return { ...frozen, archivePath };
}

async function unitFingerprint(input: { phase: LoadedProjectPhase; campaign: Campaign; config: FactoryConfig; project: LoadedGameFactoryProject; dependencies: Record<string, string | undefined>; frozenSpec?: { spec: GameSpec; fingerprint: string } }): Promise<{ fingerprint: string; spec?: { spec: GameSpec; fingerprint: string }; claimFingerprint?: string }> {
  let identityCampaign = input.campaign;
  if (input.phase.workKind === "vertical-slice") {
    const projectSlice = input.campaign.parameters?.projectSlice;
    if (projectSlice && typeof projectSlice === "object" && !Array.isArray(projectSlice)) {
      const { specRevision: _specRevision, specFingerprint: _specFingerprint, ...stableSlice } = projectSlice as Record<string, unknown>;
      identityCampaign = { ...input.campaign, parameters: { ...input.campaign.parameters, projectSlice: stableSlice } };
    }
  }
  const runId = resolveCampaignRunIdentity(identityCampaign, input.config).runId;
  const skillFingerprint = await campaignSkillFingerprint(input.campaign);
  if (input.phase.workKind === "spec-convergence") {
    const concept = input.project.preproduction ? await readFile(input.project.preproduction.conceptPath, "utf8") : "";
    const maximumConvergencePasses = input.project.preproduction?.maximumConvergencePasses ?? input.project.preproduction?.maximumRevisions ?? 3;
    return { fingerprint: hash({ kind: "spec-convergence", concept: createHash("sha256").update(concept).digest("hex"), runId, maximumConvergencePasses, skillFingerprint }) };
  }
  if (input.phase.workKind === "vertical-slice") {
    const frozenSpec = input.frozenSpec ?? await validateFrozenSpec(input.project);
    const claims = input.phase.consumesClaims ?? [];
    const unresolvedClaims = claims.filter((id) => frozenSpec.spec.claims.find((claim) => claim.id === id)?.status === "open");
    if (unresolvedClaims.length > 0) throw new Error(`Project slice ${input.phase.id} consumes unresolved GameSpec claims: ${unresolvedClaims.join(", ")}`);
    const claimFingerprint = gameSpecFingerprint(frozenSpec.spec, claims);
    const plan = frozenSpec.spec.slices.find((item) => item.id === input.phase.id);
    if (!plan) throw new Error(`Frozen GameSpec does not define project slice ${input.phase.id}`);
    const missing = claims.filter((claim) => !plan.claimIds.includes(claim));
    if (missing.length > 0) throw new Error(`Project slice ${input.phase.id} consumes claims absent from its frozen spec plan: ${missing.join(", ")}`);
    if (plan.playerOutcome !== input.phase.playerOutcome) throw new Error(`Project slice ${input.phase.id} playerOutcome differs from its frozen GameSpec plan`);
    if (plan.primaryRisk !== input.phase.primaryRisk) throw new Error(`Project slice ${input.phase.id} primaryRisk differs from its frozen GameSpec plan`);
    const implementationDependencies = Object.fromEntries(Object.entries(input.dependencies).filter(([id]) => input.project.phases.find((phase) => phase.id === id)?.workKind !== "spec-convergence"));
    return { fingerprint: hash({
      kind: "vertical-slice",
      runId,
      skillFingerprint,
      claimFingerprint,
      dependencies: implementationDependencies,
      playerOutcome: input.phase.playerOutcome,
      primaryRisk: input.phase.primaryRisk,
      nonGoals: input.phase.nonGoals ?? [],
      mutablePaths: input.phase.mutablePaths ?? [],
      evidence: input.phase.evidence ?? {},
      gate: input.phase.gate ?? {},
      attemptPolicy: input.phase.attemptPolicy ?? {}
    }), spec: frozenSpec, claimFingerprint };
  }
  return { fingerprint: hash({ kind: "legacy-phase", runId, skillFingerprint, manifest: projectManifestFingerprint(rawProject(input.project)) }) };
}

export class ProjectRunner {
  readonly journal: ProjectJourneyJournal;
  readonly manifestFingerprint: string;
  private historyImport?: Promise<void>;

  constructor(readonly project: LoadedGameFactoryProject, private readonly options: ProjectRunnerOptions) {
    const logicalJournal = join(".factory", "projects", project.id, "journey.jsonl");
    this.journal = new ProjectJourneyJournal(resolveFactoryStatePath({ cwd: project.root, ...(options.dataRoot ? { dataRoot: options.dataRoot } : {}) }, logicalJournal, logicalJournal, "project journey"), options.journeyIndex);
    this.manifestFingerprint = projectManifestFingerprint(rawProject(project));
  }

  private async ensureHistoryImported(): Promise<void> {
    if (!this.project.historyPath) return;
    this.historyImport ??= (async () => {
      const seed = await new ProjectJourneyJournal(this.project.historyPath!).read();
      for (const event of seed) {
        const { version: _version, sequence: _sequence, timestamp: _timestamp, ...input } = event;
        await this.journal.append(input);
      }
    })();
    await this.historyImport;
  }

  async readJourney(): Promise<Awaited<ReturnType<ProjectJourneyJournal["read"]>>> {
    await this.ensureHistoryImported();
    return this.journal.read();
  }

  async approve(phaseId: string, approver: string): Promise<ProjectJourneyEvent> {
    await this.ensureHistoryImported();
    if (!approver.trim()) throw new Error("Human approval requires a non-empty approver identity.");
    const phase = this.project.phases.find((item) => item.id === phaseId);
    if (!phase) throw new Error(`Unknown project phase ${phaseId}.`);
    if (!phase.gate?.requireHumanApproval) throw new Error(`Project phase ${phaseId} does not require human approval.`);
    const initial = await this.journal.read();
    const latestStart = [...initial].reverse().find((event) => event.type === "project-started");
    if (!latestStart) throw new Error("Project has not been run; there is no promotion to approve.");
    if (latestStart.manifestFingerprint !== this.manifestFingerprint) throw new Error("Project manifest changed after the pending promotion was produced; rerun the project before approving.");
    const logicalLease = join(".factory", "projects", this.project.id, "run.lock");
    const leasePath = resolveFactoryStatePath({ cwd: this.project.root, ...(this.options.dataRoot ? { dataRoot: this.options.dataRoot } : {}) }, logicalLease, logicalLease, "project lease");
    const release = await acquireProjectLease(leasePath, `${latestStart.projectRunId}:approval`);
    try {
      const events = await this.journal.read();
      const runEvents = events.filter((event) => event.projectRunId === latestStart.projectRunId);
      if (runEvents.some((event) => event.type === "project-finished")) throw new Error("Project run is already complete.");
      const intent = [...runEvents].reverse().find((event) => event.type === "promotion-intent" && event.phaseId === phaseId);
      if (!intent?.unitFingerprint || !intent.phaseAttemptId || !intent.resultingRevision) throw new Error(`Phase ${phaseId} has no complete, evidence-bound promotion awaiting approval.`);
      if (intent.manifestFingerprint !== this.manifestFingerprint) throw new Error("Promotion intent targets a different project manifest fingerprint.");
      const laterTerminal = runEvents.find((event) => event.sequence > intent.sequence && event.phaseId === phaseId && (event.type === "promotion-applied" || event.type === "slice-completed" || event.type === "phase-completed"));
      if (laterTerminal) throw new Error(`Phase ${phaseId} is already approved or complete.`);
      return this.journal.append({
        projectId: this.project.id,
        projectRunId: latestStart.projectRunId,
        type: "promotion-applied",
        idempotencyKey: `${latestStart.projectRunId}:${phaseId}:${intent.unitFingerprint}:approved`,
        manifestFingerprint: this.manifestFingerprint,
        phaseId,
        phaseAttemptId: intent.phaseAttemptId,
        ...(intent.workKind ? { workKind: intent.workKind } : {}),
        unitFingerprint: intent.unitFingerprint,
        ...(intent.specRevision !== undefined ? { specRevision: intent.specRevision } : {}),
        ...(intent.specFingerprint ? { specFingerprint: intent.specFingerprint } : {}),
        ...(intent.consumedClaims ? { consumedClaims: intent.consumedClaims } : {}),
        ...(intent.campaignId ? { campaignId: intent.campaignId } : {}),
        ...(intent.runId ? { runId: intent.runId } : {}),
        actor: { kind: "user", id: approver.trim() },
        ...(intent.sourceRevision ? { sourceRevision: intent.sourceRevision } : {}),
        resultingRevision: intent.resultingRevision,
        ...(intent.artifacts ? { artifacts: intent.artifacts } : {}),
        data: journalData({ promotionIntentSequence: intent.sequence, approvedEvidenceSha256: (intent.artifacts ?? []).map((artifact) => artifact.sha256).filter(Boolean) })
      });
    } finally { await release(); }
  }

  async doctor(): Promise<Array<{ phaseId: string; attemptId: string; capability: string; ok: boolean; message: string }>> {
    const output: Array<{ phaseId: string; attemptId: string; capability: string; ok: boolean; message: string }> = [];
    for (const phase of [...this.project.phases].sort((a, b) => a.order - b.order)) {
      const attempt = activeAttempt(phase);
      const [loadedCampaign, config] = await Promise.all([loadCampaign(attempt.campaignPath), loadFactoryConfig(attempt.configPath)]);
      const campaign = campaignForPhase(loadedCampaign, phase, this.project);
      const runner = new FactoryRunner({ cwd: this.project.root, ...(this.options.dataRoot ? { dataRoot: this.options.dataRoot } : {}), ...(this.options.worktreeRoot ? { worktreeRoot: this.options.worktreeRoot } : {}), ...(this.options.onTraceEvent ? { onTraceEvent: this.options.onTraceEvent } : {}), config, logger: this.options.logger, ...(this.options.signal ? { signal: this.options.signal } : {}) });
      try { await runner.initialize(); for (const check of await runner.doctor(campaign)) output.push({ phaseId: phase.id, attemptId: attempt.id, ...check }); }
      finally { await runner.dispose(); }
    }
    if (this.project.apiVersion === "gamefactory.dev/v2" && this.project.preproduction) {
      try { await readFile(this.project.preproduction.conceptPath, "utf8"); output.push({ phaseId: this.project.preproduction.id ?? "spec-convergence", attemptId: activeAttempt(this.project.phases[0]!).id, capability: "project:concept", ok: true, message: "Concept source is readable." }); }
      catch (error) { output.push({ phaseId: this.project.preproduction.id ?? "spec-convergence", attemptId: activeAttempt(this.project.phases[0]!).id, capability: "project:concept", ok: false, message: error instanceof Error ? error.message : String(error) }); }
    }
    return output;
  }

  async run(): Promise<ProjectRunResult> {
    const controller = new AbortController();
    const abort = () => controller.abort(this.options.signal?.reason);
    if (this.options.signal?.aborted) abort();
    this.options.signal?.addEventListener("abort", abort, { once: true });
    await this.ensureHistoryImported();
    const events = await this.journal.read();
    const latestStart = [...events].reverse().find((event) => event.type === "project-started");
    const terminal = latestStart && events.some((event) => event.projectRunId === latestStart.projectRunId && event.type === "project-finished");
    let projectRunId = latestStart && !terminal && latestStart.manifestFingerprint === this.manifestFingerprint ? latestStart.projectRunId : `${this.project.id}-${randomUUID()}`;
    let startedAt = latestStart?.projectRunId === projectRunId ? latestStart.timestamp : new Date().toISOString();
    const baseRevision = await gitRevision(this.project.root);
    if (latestStart?.projectRunId === projectRunId) {
      const latestRevision = [...events].reverse().find((event) => {
        if (event.projectRunId !== projectRunId || !event.resultingRevision) return false;
        const data = event.data && typeof event.data === "object" && !Array.isArray(event.data) ? event.data as Record<string, unknown> : undefined;
        return data?.reused !== true;
      })?.resultingRevision ?? latestStart.sourceRevision;
      if (latestRevision && baseRevision && latestRevision !== baseRevision) {
        const runEvents = events.filter((event) => event.projectRunId === projectRunId);
        if (runEvents.length !== 1 || runEvents[0]?.type !== "project-started") throw new Error(`Project revision changed outside the recorded journey: expected ${latestRevision}, found ${baseRevision}.`);
        const reconciliationLease = join(".factory", "projects", this.project.id, "run.lock");
        const reconciliationLeasePath = resolveFactoryStatePath({ cwd: this.project.root, ...(this.options.dataRoot ? { dataRoot: this.options.dataRoot } : {}) }, reconciliationLease, reconciliationLease, "project lease");
        const releaseReconciliation = await acquireProjectLease(reconciliationLeasePath, `${projectRunId}:supersede-before-execution`);
        try {
          await this.journal.append({
            projectId: this.project.id,
            projectRunId,
            type: "project-finished",
            idempotencyKey: `${projectRunId}:superseded-before-execution:${baseRevision}`,
            manifestFingerprint: this.manifestFingerprint,
            actor: { kind: "factory" },
            data: { status: "superseded-before-execution", expectedRevision: latestRevision, actualRevision: baseRevision },
          });
        } finally {
          await releaseReconciliation();
        }
        projectRunId = `${this.project.id}-${randomUUID()}`;
        startedAt = new Date().toISOString();
      }
    }
    const logicalLease = join(".factory", "projects", this.project.id, "run.lock");
    const leasePath = resolveFactoryStatePath({ cwd: this.project.root, ...(this.options.dataRoot ? { dataRoot: this.options.dataRoot } : {}) }, logicalLease, logicalLease, "project lease");
    const release = await acquireProjectLease(leasePath, projectRunId);
    const phases: ProjectRunResult["phases"] = [];
    try {
      if (latestStart?.projectRunId !== projectRunId) await this.journal.append({ projectId: this.project.id, projectRunId, type: "project-started", idempotencyKey: `${projectRunId}:started`, manifestFingerprint: this.manifestFingerprint, actor: { kind: "factory" }, ...(baseRevision ? { sourceRevision: baseRevision } : {}), data: { title: this.project.title } });
      let currentEvents = await this.journal.read();
      const completionTypes = new Set<ProjectJourneyEvent["type"]>(["phase-completed", "spec-frozen", "slice-completed", "promotion-applied"]);
      const completedEvents = currentEvents.filter((event) => event.projectRunId === projectRunId && completionTypes.has(event.type));
      const completed = new Set(completedEvents.map((event) => event.phaseId).filter((id): id is string => Boolean(id)));
      const acceptedByPhase = new Map<string, string | undefined>();
      for (const event of completedEvents) if (event.phaseId) acceptedByPhase.set(event.phaseId, event.resultingRevision);
      let frozenSpec: { spec: GameSpec; fingerprint: string } | undefined;
      const pending = pendingAmendmentFromJournal(currentEvents, projectRunId);
      let pendingAmendment: ProjectSpecAmendmentRequest | undefined = pending?.request;
      const amendmentCounts = new Map<string, number>();
      for (const event of currentEvents) if (event.projectRunId === projectRunId && event.type === "slice-invalidated" && event.phaseId) amendmentCounts.set(event.phaseId, (amendmentCounts.get(event.phaseId) ?? 0) + 1);
      const orderedPhases = [...this.project.phases].sort((left, right) => left.order - right.order);
      if (pending) {
        completed.delete(this.project.preproduction?.id ?? "spec-convergence");
        completed.delete(pending.phaseId);
        acceptedByPhase.delete(this.project.preproduction?.id ?? "spec-convergence");
        acceptedByPhase.delete(pending.phaseId);
      }
      for (let phaseIndex = 0; phaseIndex < orderedPhases.length;) {
        currentEvents = await this.journal.read();
        const phase = orderedPhases[phaseIndex]!;
        const missing = (phase.dependsOn ?? []).filter((id) => !completed.has(id));
        if (missing.length > 0) {
          const reasons = [`Dependencies are incomplete: ${missing.join(", ")}`];
          phases.push({ phaseId: phase.id, attemptId: activeAttempt(phase).id, status: "blocked", reasons, ...(phase.workKind ? { workKind: phase.workKind } : {}) });
          await this.journal.append({ projectId: this.project.id, projectRunId, type: "project-blocked", idempotencyKey: `${projectRunId}:blocked:${phase.id}:dependencies`, manifestFingerprint: this.manifestFingerprint, phaseId: phase.id, actor: { kind: "factory" }, data: { reasons } });
          return { projectId: this.project.id, projectRunId, status: "blocked", startedAt, finishedAt: new Date().toISOString(), phases };
        }
        const attempt = activeAttempt(phase);
        const [loadedCampaign, config] = await Promise.all([loadCampaign(attempt.campaignPath), loadFactoryConfig(attempt.configPath)]);
        const campaign = campaignForPhase(loadedCampaign, phase, this.project, phase.workKind === "spec-convergence" ? pendingAmendment : undefined, frozenSpec);
        const runId = resolveCampaignRunIdentity(campaign, config).runId;
        const dependencies = Object.fromEntries((phase.dependsOn ?? []).map((id) => [id, acceptedByPhase.get(id)]));
        const unit = await unitFingerprint({ phase, campaign, config, project: this.project, dependencies, ...(frozenSpec ? { frozenSpec } : {}) });
        const phaseKind = phase.workKind ?? "legacy-phase";
        const currentCompletion = [...currentEvents].reverse().find((event) => event.projectRunId === projectRunId && event.phaseId === phase.id && completionTypes.has(event.type) && (phaseKind === "legacy-phase" || event.unitFingerprint === unit.fingerprint));
        let reusable = currentCompletion;
        if (!reusable && phaseKind !== "legacy-phase") reusable = [...currentEvents].reverse().find((event) => event.phaseId === phase.id && completionTypes.has(event.type) && event.unitFingerprint === unit.fingerprint);
        if (reusable && phaseKind === "spec-convergence") {
          try {
            frozenSpec = await validateFrozenSpec(this.project);
            if (reusable.specFingerprint !== frozenSpec.fingerprint) reusable = undefined;
          }
          catch { reusable = undefined; }
        }
        if (reusable) {
          completed.add(phase.id);
          acceptedByPhase.set(phase.id, reusable.resultingRevision);
          const reusedAcrossRuns = reusable.projectRunId !== projectRunId;
          if (reusedAcrossRuns) {
            const reusableData = reusable.data && typeof reusable.data === "object" && !Array.isArray(reusable.data) ? reusable.data as Record<string, JournalJsonValue> : {};
            await this.journal.append({ projectId: this.project.id, projectRunId, type: eventType(phase, "complete"), idempotencyKey: `${projectRunId}:${phase.id}:reused:${unit.fingerprint}`, manifestFingerprint: this.manifestFingerprint, phaseId: phase.id, phaseAttemptId: attempt.id, workKind: phaseKind, unitFingerprint: unit.fingerprint, ...(reusable.specRevision !== undefined ? { specRevision: reusable.specRevision } : {}), ...(reusable.specFingerprint ? { specFingerprint: reusable.specFingerprint } : {}), ...(phase.consumesClaims ? { consumedClaims: phase.consumesClaims } : {}), campaignId: campaign.id, runId, actor: { kind: "factory" }, ...(reusable.resultingRevision ? { resultingRevision: reusable.resultingRevision } : {}), data: { ...reusableData, reused: true, reusedFromProjectRunId: reusable.projectRunId } });
          }
          phases.push({ phaseId: phase.id, attemptId: attempt.id, status: "complete", ...(reusable.resultingRevision ? { acceptedRevision: reusable.resultingRevision } : {}), workKind: phaseKind, unitFingerprint: unit.fingerprint, reused: reusedAcrossRuns });
          phaseIndex += 1;
          continue;
        }
        const startType = eventType(phase, "started");
        const terminalTypes = new Set<ProjectJourneyEvent["type"]>([eventType(phase, "complete"), eventType(phase, "blocked")]);
        const phaseStarts = currentEvents.filter((event) => event.projectRunId === projectRunId && event.phaseId === phase.id && event.phaseAttemptId === attempt.id && event.type === startType && (phaseKind === "legacy-phase" || event.unitFingerprint === unit.fingerprint));
        const latestPhaseStart = phaseStarts.at(-1);
        const latestPhaseTerminal = latestPhaseStart && currentEvents.some((event) => event.projectRunId === projectRunId && event.phaseId === phase.id && event.sequence > latestPhaseStart.sequence && terminalTypes.has(event.type));
        const execution = latestPhaseStart && !latestPhaseTerminal ? phaseStarts.length : phaseStarts.length + 1;
        const phaseKey = `${projectRunId}:${phase.id}:${attempt.id}:${unit.fingerprint.slice(0, 12)}:e${String(execution).padStart(4, "0")}`;
        if (!latestPhaseStart || latestPhaseTerminal) {
          const phaseRevision = await gitRevision(this.project.root);
          await this.journal.append({ projectId: this.project.id, projectRunId, type: startType, idempotencyKey: `${phaseKey}:started`, manifestFingerprint: this.manifestFingerprint, phaseId: phase.id, phaseAttemptId: attempt.id, workKind: phaseKind, unitFingerprint: unit.fingerprint, ...(phase.consumesClaims ? { consumedClaims: phase.consumesClaims } : {}), campaignId: campaign.id, runId, actor: { kind: "factory" }, ...(phaseRevision ? { sourceRevision: phaseRevision } : {}), data: journalData({ ...(phase.playerOutcome ? { playerOutcome: phase.playerOutcome } : {}), ...(phase.primaryRisk ? { primaryRisk: phase.primaryRisk } : {}), ...(phase.attemptPolicy ? { attemptPolicy: phase.attemptPolicy } : {}) }) });
          await this.journal.append({ projectId: this.project.id, projectRunId, type: "campaign-linked", idempotencyKey: `${phaseKey}:campaign-linked`, manifestFingerprint: this.manifestFingerprint, phaseId: phase.id, phaseAttemptId: attempt.id, workKind: phaseKind, unitFingerprint: unit.fingerprint, campaignId: campaign.id, runId, actor: { kind: "factory" } });
        }
        let campaignResult: CampaignResult;
        if (this.options.executeCampaign) campaignResult = await this.options.executeCampaign({ campaign, config, signal: controller.signal });
        else {
          const runner = new FactoryRunner({ cwd: this.project.root, ...(this.options.dataRoot ? { dataRoot: this.options.dataRoot } : {}), ...(this.options.worktreeRoot ? { worktreeRoot: this.options.worktreeRoot } : {}), ...(this.options.onTraceEvent ? { onTraceEvent: this.options.onTraceEvent } : {}), config, logger: this.options.logger, signal: controller.signal });
          try { await runner.initialize(); campaignResult = await runner.run(campaign); }
          finally { await runner.dispose(); }
        }
        const gate = gateReasons(phase, campaignResult);
        gate.reasons.push(...evidenceReasons(phase, campaignResult, frozenSpec));
        let specArchivePath: string | undefined;
        if (phaseKind === "spec-convergence" && gate.reasons.length === 0) {
          try {
            const archived = await validateSpecLineageAndArchive({ project: this.project, events: await this.journal.read(), ...(this.options.dataRoot ? { dataRoot: this.options.dataRoot } : {}) });
            frozenSpec = { spec: archived.spec, fingerprint: archived.fingerprint };
            specArchivePath = archived.archivePath;
          }
          catch (error) { gate.reasons.push(error instanceof Error ? error.message : String(error)); }
        }
        if (gate.reasons.length > 0) {
          const amendment = phaseKind === "vertical-slice" ? specAmendmentRequest(phase, campaignResult) : undefined;
          const amendmentCount = amendmentCounts.get(phase.id) ?? 0;
          const amendmentLimit = phase.attemptPolicy?.specAmendments ?? 0;
          if (amendment && amendmentCount < amendmentLimit) {
            amendmentCounts.set(phase.id, amendmentCount + 1);
            const cited = new Set(amendment.evidenceArtifactSha256);
            await this.journal.append({
              projectId: this.project.id,
              projectRunId,
              type: "slice-invalidated",
              idempotencyKey: `${phaseKey}:invalidated:spec-amendment-${amendmentCount + 1}`,
              manifestFingerprint: this.manifestFingerprint,
              phaseId: phase.id,
              phaseAttemptId: attempt.id,
              workKind: phaseKind,
              unitFingerprint: unit.fingerprint,
              ...(phase.consumesClaims ? { consumedClaims: phase.consumesClaims } : {}),
              campaignId: campaign.id,
              runId,
              actor: { kind: "agent" },
              artifacts: campaignResult.experiments.flatMap((record) => experimentArtifacts(record)).filter((artifact) => artifact.sha256 && cited.has(artifact.sha256)),
              data: journalData({ amendment, reasons: gate.reasons, attempt: amendmentCount + 1, maximum: amendmentLimit })
            });
            pendingAmendment = amendment;
            const specId = this.project.preproduction?.id ?? "spec-convergence";
            completed.delete(specId);
            completed.delete(phase.id);
            acceptedByPhase.delete(specId);
            acceptedByPhase.delete(phase.id);
            frozenSpec = undefined;
            phaseIndex = 0;
            continue;
          }
          if (amendment && amendmentCount >= amendmentLimit) gate.reasons.push(`Slice requested a GameSpec amendment after its limit of ${amendmentLimit} was exhausted.`);
          const approvalOnly = phase.gate?.requireHumanApproval === true && gate.reasons.length === 1 && gate.reasons[0]?.startsWith("Phase requires human approval");
          if (approvalOnly && gate.acceptedRevision) {
            const approvalArtifacts = trustedFactoryArtifacts(campaignResult).map((entry) => entry.artifact);
            await this.journal.append({ projectId: this.project.id, projectRunId, type: "promotion-intent", idempotencyKey: `${phaseKey}:promotion-intent`, manifestFingerprint: this.manifestFingerprint, phaseId: phase.id, phaseAttemptId: attempt.id, workKind: phaseKind, unitFingerprint: unit.fingerprint, ...(frozenSpec ? { specRevision: frozenSpec.spec.revision, specFingerprint: frozenSpec.fingerprint } : {}), ...(phase.consumesClaims ? { consumedClaims: phase.consumesClaims } : {}), campaignId: campaign.id, runId, actor: { kind: "factory" }, resultingRevision: gate.acceptedRevision, artifacts: approvalArtifacts, data: journalData({ evidenceSha256: approvalArtifacts.map((artifact) => artifact.sha256).filter(Boolean) }) });
          }
          phases.push({ phaseId: phase.id, attemptId: attempt.id, status: "blocked", campaignResult, reasons: gate.reasons, ...(gate.acceptedRevision ? { acceptedRevision: gate.acceptedRevision } : {}), workKind: phaseKind, unitFingerprint: unit.fingerprint });
          await this.journal.append({ projectId: this.project.id, projectRunId, type: eventType(phase, "blocked"), idempotencyKey: `${phaseKey}:blocked`, manifestFingerprint: this.manifestFingerprint, phaseId: phase.id, phaseAttemptId: attempt.id, workKind: phaseKind, unitFingerprint: unit.fingerprint, ...(phase.consumesClaims ? { consumedClaims: phase.consumesClaims } : {}), campaignId: campaign.id, runId, actor: { kind: "factory" }, ...(gate.acceptedRevision ? { resultingRevision: gate.acceptedRevision } : {}), data: { reasons: gate.reasons, campaignStatus: campaignResult.status } });
          await this.journal.append({ projectId: this.project.id, projectRunId, type: "project-blocked", idempotencyKey: `${phaseKey}:project-blocked`, manifestFingerprint: this.manifestFingerprint, phaseId: phase.id, phaseAttemptId: attempt.id, campaignId: campaign.id, runId, actor: { kind: "factory" }, data: { reasons: gate.reasons } });
          return { projectId: this.project.id, projectRunId, status: "blocked", startedAt, finishedAt: new Date().toISOString(), phases };
        }
        completed.add(phase.id);
        acceptedByPhase.set(phase.id, gate.acceptedRevision);
        phases.push({ phaseId: phase.id, attemptId: attempt.id, status: "complete", campaignResult, ...(gate.acceptedRevision ? { acceptedRevision: gate.acceptedRevision } : {}), workKind: phaseKind, unitFingerprint: unit.fingerprint });
        await this.journal.append({ projectId: this.project.id, projectRunId, type: eventType(phase, "complete"), idempotencyKey: `${phaseKey}:completed`, manifestFingerprint: this.manifestFingerprint, phaseId: phase.id, phaseAttemptId: attempt.id, workKind: phaseKind, unitFingerprint: unit.fingerprint, ...(frozenSpec ? { specRevision: frozenSpec.spec.revision, specFingerprint: frozenSpec.fingerprint } : {}), ...(phase.consumesClaims ? { consumedClaims: phase.consumesClaims } : {}), campaignId: campaign.id, runId, actor: { kind: "factory" }, ...(gate.acceptedRevision ? { resultingRevision: gate.acceptedRevision } : {}), data: journalData({ bestMetrics: campaignResult.bestMetrics, ...(unit.claimFingerprint ? { claimFingerprint: unit.claimFingerprint } : {}), ...(phaseKind === "spec-convergence" && frozenSpec?.spec.change ? { specChange: frozenSpec.spec.change } : {}), ...(phaseKind === "spec-convergence" && frozenSpec?.spec.supersedes ? { supersedes: frozenSpec.spec.supersedes } : {}), ...(phaseKind === "spec-convergence" && specArchivePath ? { specArchivePath } : {}) }) });
        if (phaseKind === "spec-convergence") pendingAmendment = undefined;
        phaseIndex += 1;
      }
      const resultingRevision = await gitRevision(this.project.root);
      await this.journal.append({ projectId: this.project.id, projectRunId, type: "project-finished", idempotencyKey: `${projectRunId}:finished`, manifestFingerprint: this.manifestFingerprint, actor: { kind: "factory" }, ...(resultingRevision ? { resultingRevision } : {}) });
      return { projectId: this.project.id, projectRunId, status: "complete", startedAt, finishedAt: new Date().toISOString(), phases };
    } catch (error) {
      if (controller.signal.aborted) return { projectId: this.project.id, projectRunId, status: "cancelled", startedAt, finishedAt: new Date().toISOString(), phases };
      throw error;
    } finally {
      this.options.signal?.removeEventListener("abort", abort);
      await release();
    }
  }
}
