import type { EffectivePromptManifest, Experiment, FactorySnapshot, GraphEdge, GraphNode, Usage } from "./types";

const baseTime = new Date("2026-08-12T13:37:49.387Z").getTime();
const at = (seconds: number) => new Date(baseTime + seconds * 1000).toISOString();

function subscriptionUsage(): Usage {
  return { billingMode: "subscription" };
}

function demoPrompt(role: string, contributorId: string, experimentId: string): EffectivePromptManifest {
  const layers = [
    { id: "project-1", kind: "project" as const, source: "AGENTS.md", content: "Keep the core small, preserve evidence, and distinguish deterministic fixtures from real model runs." },
    { id: "campaign-objective", kind: "campaign" as const, source: "campaign.objective", content: "Find a responsive, readable movement balance without reducing the game to its proxy metric." },
    { id: "role-charter", kind: "role" as const, source: `extensions/agent-team/instructions/${role}.md`, content: `${role} owns a bounded contribution and must return evidence, assumptions, and a structured outcome.` },
    { id: "node-task", kind: "task" as const, source: "agentTeam.node.instructions", content: `Complete the ${role} contribution for ${experimentId}.` },
  ].map((layer) => ({ ...layer, sha256: "example-replay-not-a-content-hash", version: layer.kind === "role" ? "1.0.0" : undefined }));
  return {
    version: 1,
    scope: "factory-supplied",
    generatedAt: at(0),
    adapter: "deterministic-fixture",
    provider: "local",
    billingMode: "subscription",
    instructionSources: ["AGENTS.md"],
    layers,
    context: { objective: "Find a responsive, readable movement balance.", role, contributorId, experimentId, candidateRoot: "portable replay", readOnly: role !== "implementer", upstreamOutputs: role === "scout" ? 0 : 1, contextReferences: 0, historyRecords: 0 },
    limitations: ["Example replay: these layers demonstrate provenance, but no language model was invoked."]
  };
}

const nodes: GraphNode[] = [];
const edges: GraphEdge[] = [];
const experiments: Experiment[] = [];

function node(value: Omit<GraphNode, "artifacts" | "metrics"> & Partial<Pick<GraphNode, "artifacts" | "metrics">>) {
  nodes.push({ artifacts: 0, metrics: 0, ...value });
}

function edge(source: string, target: string, enteredSequence: number, kind: GraphEdge["kind"] = "flow", label?: string) {
  edges.push({ id: `${source}->${target}`, source, target, enteredSequence, kind, label });
}

node({
  id: "run:pulse-runner-demo",
  kind: "campaign",
  label: "Pulse Runner",
  detail: "Tournament · 3 candidates",
  column: 0,
  order: 5,
  enteredSequence: 1,
  completedSequence: 126,
  finalState: "complete",
});

const extensionNodes = [
  ["gamefactory.tournament", "0.1.0", ["workflow:tournament"], "Runs parallel candidate tournaments"],
  ["gamefactory.git", "0.1.0", ["workspace:git.worktree"], "Creates isolated candidate worktrees"],
  ["gamefactory.agent-team", "0.1.0", ["agent:agent.team"], "Coordinates scout, builder, and playtester agents"],
  ["gamefactory.godot", "0.1.0", ["engine:godot.engine", "scenario:godot.scenario", "evaluator:godot.scenario"], "Runs the game and deterministic playtests"],
  ["gamefactory.design-lab", "0.1.0", ["evaluator:playtest.agents"], "Scores synthetic playtest evidence"],
  ["gamefactory.asset-foundry", "0.1.0", ["agent:asset.command", "evaluator:asset.style"], "Generates and validates styled game assets"],
] as const;

extensionNodes.forEach(([name, version, capabilities, detail], index) => {
  const id = `extension:${name}`;
  node({ id, kind: "extension", label: name, detail, column: 1, order: -6 + index, enteredSequence: 1 + index, completedSequence: 2 + index, finalState: "complete", provenance: { provenanceType: "extension", version, capabilities: [...capabilities], activationReason: capabilities[0], permissions: name === "gamefactory.godot" ? ["process:godot", "filesystem:artifacts"] : [] } });
  edge("run:pulse-runner-demo", id, 1 + index, "flow", `activated for ${capabilities[0]}`);
});

node({ id: "resource:pulse-runner-neon", kind: "resource", label: "Style · pulse-runner-neon@1.0.0", detail: "Controlled neon silhouettes for a dark arena", column: 2, order: -1, enteredSequence: 7, completedSequence: 8, finalState: "complete", artifacts: 1, metrics: 7, provenance: { provenanceType: "creative-input", resourceType: "style-profile", id: "pulse-runner-neon", version: "1.0.0", path: "style-profile.json", sha256: "720f06bf3d5337cf3be0707f804d80441cd935704e201dcddee24211d1c50faa", modalities: ["image"], references: [{ role: "canonical enemy silhouette, palette, and rendering treatment", path: "asset-sources/drone-variant-1.png" }] } });
edge("extension:gamefactory.asset-foundry", "resource:pulse-runner-neon", 7, "evidence", "pins art direction");

const candidates = [
  { id: "candidate-a", speed: 255, score: 0.79, state: "discard" as const, start: 8, order: 2, finish: 103 },
  { id: "candidate-b", speed: 290, score: 0.91, state: "keep" as const, start: 11, order: 6, finish: 121 },
  { id: "candidate-c", speed: 270, score: 0.84, state: "discard" as const, start: 14, order: 10, finish: 112 },
];

for (const [slot, candidate] of candidates.entries()) {
  const workspace = `${candidate.id}:workspace`;
  const team = `${candidate.id}:team`;
  const evaluator = `${candidate.id}:evaluator`;
  const decision = `${candidate.id}:decision`;
  const outcome = `${candidate.id}:outcome`;
  const agents = [
    { id: "systems-scout", role: "scout", delta: 1, summary: "Mapped movement, survival, and collection constraints." },
    { id: "lead-builder", role: "implementer", delta: 2, summary: `Raised player speed to ${candidate.speed} while preserving the scenario contract.` },
    { id: "playtest-critic", role: "critic", delta: 3, summary: "Ran deterministic play traces and checked difficulty shape." },
  ];

  node({ id: candidate.id, experimentId: candidate.id, clusterId: candidate.id, kind: "candidate", label: `Candidate ${String.fromCharCode(65 + slot)}`, detail: `player_speed ${candidate.speed}`, column: 3, order: candidate.order, enteredSequence: candidate.start, completedSequence: candidate.finish, finalState: "complete" });
  node({ id: workspace, experimentId: candidate.id, clusterId: candidate.id, kind: "workspace", label: "Git worktree", detail: "Isolated candidate", column: 4, order: candidate.order, enteredSequence: candidate.start + 3, completedSequence: candidate.finish - 3, finalState: "complete" });
  node({ id: team, experimentId: candidate.id, clusterId: candidate.id, kind: "agent", label: "Agent team · 3", detail: "Scout → builder → playtester", column: 5, order: candidate.order, enteredSequence: candidate.start + 5, completedSequence: candidate.finish - 18, finalState: "complete", usage: subscriptionUsage() });

  edge("run:pulse-runner-demo", candidate.id, candidate.start, "fan-out");
  edge("resource:pulse-runner-neon", candidate.id, candidate.start, "evidence", "style constraint");
  edge(candidate.id, workspace, candidate.start + 3);
  edge(workspace, team, candidate.start + 5);

  const contributions = agents.map((agent, agentIndex) => {
    const id = `${candidate.id}:${agent.id}`;
    const agentUsage = subscriptionUsage();
    node({
      id,
      experimentId: candidate.id,
      clusterId: candidate.id,
      kind: "contributor",
      label: agent.id,
      detail: `${agent.role} · attempt 1`,
      column: 6,
      order: candidate.order + agentIndex - 1,
      enteredSequence: candidate.start + 9 + agentIndex * 15,
      completedSequence: candidate.start + 21 + agentIndex * 16,
      finalState: "complete",
      artifacts: agentIndex === 2 ? 2 : 1,
      invocationId: `${candidate.id}-${agent.id}-1`,
      parentInvocationId: `${candidate.id}-team`,
      usage: agentUsage,
      promptManifest: demoPrompt(agent.role, agent.id, candidate.id),
    });
    edge(team, id, candidate.start + 9 + agentIndex * 15, "fan-out", agent.role);
    edge(id, evaluator, candidate.start + 68, "evidence");
    return {
      agentId: agent.id,
      role: agent.role,
      status: "complete",
      summary: agent.summary,
      startedAt: at(candidate.start + agentIndex * 4),
      finishedAt: at(candidate.start + 8 + agentIndex * 5),
      artifacts: agentIndex === 2 ? 2 : 1,
      invocationId: `${candidate.id}-${agent.id}-1`,
      parentInvocationId: `${candidate.id}-team`,
      usage: agentUsage,
    };
  });

  node({ id: evaluator, experimentId: candidate.id, clusterId: candidate.id, kind: "evaluator", label: "Godot playtest", detail: `fun_score ${candidate.score.toFixed(2)}`, column: 7, order: candidate.order, enteredSequence: candidate.start + 68, completedSequence: candidate.start + 79, finalState: "pass", artifacts: 4, metrics: 4 });
  node({ id: decision, experimentId: candidate.id, clusterId: candidate.id, kind: "decision", label: "Round decision", detail: candidate.state === "keep" ? "Selected for acceptance" : "Ranked below winner", column: 8, order: candidate.order, enteredSequence: candidate.start + 82, completedSequence: candidate.finish - 4, finalState: candidate.state });
  node({ id: outcome, experimentId: candidate.id, clusterId: candidate.id, kind: "outcome", label: candidate.state === "keep" ? "Accepted" : "Discarded", detail: candidate.state === "keep" ? "Applied to main" : "Workspace cleaned", column: 9, order: candidate.order, enteredSequence: candidate.finish - 4, completedSequence: candidate.finish, finalState: candidate.state });
  edge(evaluator, decision, candidate.start + 82, "decision");
  edge(decision, outcome, candidate.finish - 4, "decision", candidate.state);

  experiments.push({
    id: candidate.id,
    status: candidate.state,
    latestPhase: "cleaned",
    complete: true,
    startedAt: at(candidate.start),
    finishedAt: at(candidate.finish),
    durationMs: (candidate.finish - candidate.start) * 1000,
    round: 1,
    slot: slot + 1,
    summary: candidate.state === "keep" ? "Best balance of responsiveness, survival, and collection pace." : "Playable and valid, but ranked below Candidate B.",
    metrics: { fun_score: candidate.score, completion: 1, pickups: 8 + slot, survival_seconds: 42 - slot * 2 },
    primaryMetric: candidate.score,
    agentSummary: `Three-agent team proposed and tested player_speed ${candidate.speed}.`,
    contributors: contributions,
    usage: subscriptionUsage(),
    artifacts: [
      { id: `${candidate.id}-frame`, kind: "image", label: "Godot playtest frame", mediaType: "image/png", sizeBytes: 218400, available: false },
      { id: `${candidate.id}-telemetry`, kind: "telemetry", label: "Deterministic telemetry", mediaType: "application/x-ndjson", sizeBytes: 48200, available: false },
    ],
    phases: [
      { sequence: candidate.start, phase: "reserved", timestamp: at(candidate.start), note: "Budget slot reserved" },
      { sequence: candidate.start + 3, phase: "candidate-created", timestamp: at(candidate.start + 3), note: "Isolated worktree created" },
      { sequence: candidate.start + 68, phase: "evaluated", timestamp: at(candidate.start + 68), note: "Godot scenario passed" },
      { sequence: candidate.finish - 4, phase: "acceptance-intent", timestamp: at(candidate.finish - 4), note: candidate.state === "keep" ? "Winner selected" : "Candidate discarded" },
      { sequence: candidate.finish, phase: "cleaned", timestamp: at(candidate.finish), note: "Experiment finalized" },
    ],
    evaluations: [{ evaluator: "godot.scenario", status: "pass", summary: "Deterministic playtest completed without violations.", metrics: { fun_score: candidate.score, completion: 1, pickups: 8 + slot, survival_seconds: 42 - slot * 2 }, violations: 0, artifacts: 4 }],
    resultSequence: candidate.finish,
    evaluatedSequence: candidate.start + 68,
  });
}

export const demoSnapshot: FactorySnapshot = {
  version: 2,
  generatedAt: at(130),
  campaign: {
    id: "pulse-runner-demo",
    objective: "Find the most responsive, readable, and replayable movement balance for a compact Godot score-chasing puzzle.",
    workflow: "tournament",
    primaryMetric: "fun_score",
    direction: "maximize",
  },
  runId: "pulse-runner-demo-7a3f",
  live: false,
  sequence: 126,
  startedAt: at(0),
  finishedAt: at(126),
  durationMs: 126000,
  runs: [{ id: "pulse-runner-demo-7a3f", startedAt: at(0), finishedAt: at(126), experimentCount: 3, status: "complete" }],
  experiments,
  events: experiments.flatMap((experiment) => experiment.phases.map((phase) => ({ ...phase, experimentId: experiment.id, source: "journal" }))).sort((a, b) => a.sequence - b.sequence),
  graph: {
    nodes,
    edges,
    clusters: candidates.map((candidate, index) => ({ id: candidate.id, label: `Candidate ${String.fromCharCode(65 + index)}`, experimentId: candidate.id, nodeIds: nodes.filter((item) => item.experimentId === candidate.id).map((item) => item.id), status: candidate.state, enteredSequence: candidate.start })),
  },
  usage: {
    invocations: 9,
    tokenInvocations: 0,
    pricedInvocations: 0,
    unpricedInvocations: 9,
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    billingModes: ["subscription"],
    models: [],
  },
  counters: { experiments: 3, active: 0, kept: 1, discarded: 2, blocked: 0, crashed: 0 },
};
