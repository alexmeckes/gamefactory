import type { AcceptanceConfig, Evaluation } from "./types.js";

export interface AcceptanceDecision {
  accepted: boolean;
  reason: string;
  candidateValue?: number;
  baselineValue?: number;
}

export function flattenMetrics(evaluations: Evaluation[]): Record<string, number> {
  const output: Record<string, number> = {};
  for (const evaluation of evaluations) {
    for (const [key, value] of Object.entries(evaluation.metrics)) {
      output[`${evaluation.evaluator}.${key}`] = value;
      if (!(key in output)) output[key] = value;
    }
  }
  return output;
}

export function decideAcceptance(
  config: AcceptanceConfig,
  baselineEvaluations: Evaluation[],
  candidateEvaluations: Evaluation[]
): AcceptanceDecision {
  const failed = candidateEvaluations.filter((evaluation) => evaluation.status === "fail");
  if (failed.length > 0) return { accepted: false, reason: `hard evaluation failure: ${failed.map((item) => item.evaluator).join(", ")}` };

  const baseline = flattenMetrics(baselineEvaluations)[config.primaryMetric];
  const candidate = flattenMetrics(candidateEvaluations)[config.primaryMetric];
  if (candidate === undefined) return { accepted: false, reason: `candidate did not produce metric ${config.primaryMetric}` };
  if (baseline === undefined) return { accepted: true, reason: "first measured baseline", candidateValue: candidate };

  const delta = config.direction === "maximize" ? candidate - baseline : baseline - candidate;
  const minimum = config.minimumDelta ?? 0;
  const printableDelta = Number(delta.toPrecision(8));
  return delta > minimum
    ? { accepted: true, reason: `improved ${config.primaryMetric} by ${printableDelta}`, baselineValue: baseline, candidateValue: candidate }
    : { accepted: false, reason: `did not improve ${config.primaryMetric} by more than ${minimum}`, baselineValue: baseline, candidateValue: candidate };
}
