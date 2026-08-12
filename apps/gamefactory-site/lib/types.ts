export type NodeState =
  | "waiting"
  | "running"
  | "complete"
  | "pass"
  | "fail"
  | "inconclusive"
  | "keep"
  | "discard"
  | "blocked"
  | "crash"
  | "cancelled"
  | "baseline"
  | "skipped";

export interface Usage {
  provider?: string;
  model?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  detail?: string;
  experimentId?: string;
  clusterId?: string;
  column: number;
  order: number;
  enteredSequence: number;
  completedSequence?: number;
  finalState: NodeState;
  durationMs?: number;
  artifacts: number;
  metrics: number;
  invocationId?: string;
  parentInvocationId?: string;
  usage?: Usage;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: "flow" | "fan-out" | "evidence" | "decision";
  enteredSequence: number;
  label?: string;
}

export interface Contribution {
  agentId: string;
  role: string;
  status: string;
  summary: string;
  startedAt: string;
  finishedAt: string;
  artifacts: number;
  invocationId?: string;
  parentInvocationId?: string;
  usage?: Usage;
}

export interface Experiment {
  id: string;
  status: string;
  latestPhase: string;
  complete: boolean;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  round?: number;
  slot?: number;
  summary?: string;
  metrics: Record<string, number>;
  primaryMetric?: number;
  agentSummary?: string;
  contributors: Contribution[];
  usage?: Usage;
  artifacts: Array<{
    id: string;
    kind: string;
    label: string;
    mediaType?: string;
    sizeBytes?: number;
    available: boolean;
    url?: string;
  }>;
  phases: Array<{ sequence: number; phase: string; timestamp: string; note: string }>;
  evaluations: Array<{
    evaluator: string;
    status: string;
    summary?: string;
    metrics: Record<string, number>;
    violations: number;
    artifacts: number;
    usage?: Usage;
  }>;
  resultSequence?: number;
  evaluatedSequence?: number;
}

export interface FactorySnapshot {
  version: number;
  generatedAt: string;
  campaign: {
    id: string;
    objective: string;
    workflow: string;
    primaryMetric: string;
    direction: "maximize" | "minimize";
  };
  runId: string;
  live: boolean;
  sequence: number;
  startedAt?: string;
  finishedAt?: string;
  durationMs: number;
  runs: Array<{
    id: string;
    startedAt: string;
    finishedAt?: string;
    experimentCount: number;
    status: string;
  }>;
  experiments: Experiment[];
  events: Array<{
    sequence: number;
    phase: string;
    timestamp: string;
    note: string;
    experimentId: string;
    source: string;
    nodeId?: string;
  }>;
  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
    clusters: Array<{
      id: string;
      label: string;
      experimentId: string;
      nodeIds: string[];
      status: string;
      enteredSequence: number;
    }>;
  };
  usage: {
    invocations: number;
    tokenInvocations: number;
    pricedInvocations: number;
    unpricedInvocations: number;
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    costUsd: number;
    models: Array<{
      provider?: string;
      model?: string;
      invocations: number;
      tokenInvocations: number;
      pricedInvocations: number;
      totalTokens: number;
      costUsd: number;
    }>;
  };
  counters: {
    experiments: number;
    active: number;
    kept: number;
    discarded: number;
    blocked: number;
    crashed: number;
  };
}

export interface ReplayBundle {
  format: "gamefactory-viewer-bundle";
  version: 1;
  exportedAt: string;
  snapshot: FactorySnapshot;
}
