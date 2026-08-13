export type PromptLayerKind = "project" | "campaign" | "boundary" | "role" | "task" | "context" | "history";

export interface PromptLayer {
  id: string;
  kind: PromptLayerKind;
  source: string;
  sha256: string;
  content: string;
  version?: string;
  metadata?: Record<string, unknown>;
}

export interface EffectivePromptManifest {
  version: 1;
  scope: "factory-supplied";
  generatedAt: string;
  adapter: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  billingMode?: string;
  instructionSources: string[];
  layers: PromptLayer[];
  context: {
    objective: string;
    role: string;
    contributorId: string;
    experimentId: string;
    candidateRoot: string;
    readOnly: boolean;
    upstreamOutputs: number;
    contextReferences: number;
    historyRecords: number;
  };
  providerContext?: {
    threadId?: string;
    turnId?: string;
    instructionSources?: string[];
    modelProvider?: string;
    requestedModel?: string;
    actualModel?: string;
    requestedReasoningEffort?: string;
    reasoningEffort?: string;
  };
  limitations: string[];
}
