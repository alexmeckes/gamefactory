import type { Experiment, FactorySnapshot, GraphEdge, GraphNode, Usage } from "./types";

const baseTime = new Date("2026-08-12T13:37:49.387Z").getTime();
const at = (seconds: number) => new Date(baseTime + seconds * 1000).toISOString();

function subscriptionUsage(): Usage {
  return { billingMode: "subscription" };
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

  node({ id: candidate.id, experimentId: candidate.id, clusterId: candidate.id, kind: "candidate", label: `Candidate ${String.fromCharCode(65 + slot)}`, detail: `player_speed ${candidate.speed}`, column: 1, order: candidate.order, enteredSequence: candidate.start, completedSequence: candidate.finish, finalState: "complete" });
  node({ id: workspace, experimentId: candidate.id, clusterId: candidate.id, kind: "workspace", label: "Git worktree", detail: "Isolated candidate", column: 2, order: candidate.order, enteredSequence: candidate.start + 3, completedSequence: candidate.finish - 3, finalState: "complete" });
  node({ id: team, experimentId: candidate.id, clusterId: candidate.id, kind: "agent", label: "Agent team · 3", detail: "Scout → builder → playtester", column: 3, order: candidate.order, enteredSequence: candidate.start + 5, completedSequence: candidate.finish - 18, finalState: "complete", usage: subscriptionUsage() });

  edge("run:pulse-runner-demo", candidate.id, candidate.start, "fan-out");
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
      column: 4,
      order: candidate.order + agentIndex - 1,
      enteredSequence: candidate.start + 9 + agentIndex * 15,
      completedSequence: candidate.start + 21 + agentIndex * 16,
      finalState: "complete",
      artifacts: agentIndex === 2 ? 2 : 1,
      invocationId: `${candidate.id}-${agent.id}-1`,
      parentInvocationId: `${candidate.id}-team`,
      usage: agentUsage,
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

  node({ id: evaluator, experimentId: candidate.id, clusterId: candidate.id, kind: "evaluator", label: "Godot playtest", detail: `fun_score ${candidate.score.toFixed(2)}`, column: 5, order: candidate.order, enteredSequence: candidate.start + 68, completedSequence: candidate.start + 79, finalState: "pass", artifacts: 4, metrics: 4 });
  node({ id: decision, experimentId: candidate.id, clusterId: candidate.id, kind: "decision", label: "Round decision", detail: candidate.state === "keep" ? "Selected for acceptance" : "Ranked below winner", column: 6, order: candidate.order, enteredSequence: candidate.start + 82, completedSequence: candidate.finish - 4, finalState: candidate.state });
  node({ id: outcome, experimentId: candidate.id, clusterId: candidate.id, kind: "outcome", label: candidate.state === "keep" ? "Accepted" : "Discarded", detail: candidate.state === "keep" ? "Applied to main" : "Workspace cleaned", column: 7, order: candidate.order, enteredSequence: candidate.finish - 4, completedSequence: candidate.finish, finalState: candidate.state });
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
