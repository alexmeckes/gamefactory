export type {
  AgentDriver,
  AgentContribution,
  AgentRole,
  AgentRequest,
  AgentResult,
  ArtifactReference,
  BudgetReservationLike,
  Campaign,
  Candidate,
  CandidateContext,
  Disposable,
  EngineDriver,
  Evaluation,
  EvaluationRequest,
  Evaluator,
  ExecutionResult,
  ExtensionManifest,
  FactoryAPI,
  FactoryEvent,
  FactoryExtension,
  Logger,
  IntakeAnswer,
  IntakeDriver,
  IntakeOption,
  IntakeQuestion,
  IntakeRequest,
  IntakeResult,
  Policy,
  Reporter,
  ScenarioReference,
  ScenarioResult,
  ScenarioRunner,
  Violation,
  Workflow,
  WorkflowContext,
  WorkspaceDriver
} from "@gamefactory/core";

import type { Disposable, FactoryAPI, FactoryExtension } from "@gamefactory/core";

export type ExtensionFactory = (api: FactoryAPI) => Promise<Disposable | void> | Disposable | void;

export function defineExtension(extension: ExtensionFactory): ExtensionFactory;
export function defineExtension(extension: FactoryExtension): FactoryExtension;
export function defineExtension<T extends ExtensionFactory | FactoryExtension>(extension: T): T {
  return extension;
}

export function combineDisposables(...items: Array<{ dispose(): Promise<void> | void }>): { dispose(): Promise<void> } {
  return {
    async dispose() {
      for (const item of items.reverse()) await item.dispose();
    }
  };
}
