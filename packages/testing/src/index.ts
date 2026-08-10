import assert from "node:assert/strict";
import type { Evaluation, Evaluator, FactoryAPI, WorkspaceDriver } from "@gamefactory/core";

export async function exerciseWorkspaceDriver(driver: WorkspaceDriver, campaign: Parameters<WorkspaceDriver["createCandidate"]>[0]["campaign"]): Promise<void> {
  const signal = new AbortController().signal;
  const candidate = await driver.createCandidate({ campaign, experimentId: "contract-1", signal });
  assert.equal(candidate.id, "contract-1");
  assert.ok(candidate.root.length > 0);
  await driver.discardCandidate({ campaign, candidate, signal });
}

export async function exerciseEvaluator(evaluator: Evaluator, campaign: Parameters<Evaluator["evaluate"]>[0]["campaign"]): Promise<Evaluation> {
  const result = await evaluator.evaluate({ campaign, candidate: null, experimentId: "contract-baseline", priorEvaluations: [], signal: new AbortController().signal });
  assert.equal(result.evaluator, evaluator.id);
  assert.equal(result.version, evaluator.version);
  return result;
}

export function recordingApi(): { api: FactoryAPI; registrations: string[] } {
  const registrations: string[] = [];
  return {
    registrations,
    api: {
      extensionName: "contract-test",
      register: (kind, id) => {
        registrations.push(`${kind}:${id}`);
        return { dispose() {} };
      },
      onEvent: () => ({ dispose() {} }),
      log: { debug() {}, info() {}, warn() {}, error() {} }
    }
  };
}
