import type { AcceptanceConfig, Evaluation } from "./types.js";

export interface AcceptanceDecision {
  accepted: boolean;
  reason: string;
  candidateValue?: number;
  baselineValue?: number;
}

export interface AcceptanceRequirements {
  humanGates?: string[];
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
  candidateEvaluations: Evaluation[],
  requirements: AcceptanceRequirements = {}
): AcceptanceDecision {
  const failed = candidateEvaluations.filter((evaluation) => evaluation.status === "fail");
  if (failed.length > 0) return { accepted: false, reason: `hard evaluation failure: ${failed.map((item) => item.evaluator).join(", ")}` };

  for (const evaluatorId of config.hardGates ?? []) {
    const evaluation = candidateEvaluations.find((item) => item.evaluator === evaluatorId);
    if (!evaluation || evaluation.status !== "pass") {
      return { accepted: false, reason: `required hard gate did not pass: ${evaluatorId}` };
    }
  }
  for (const evaluatorId of requirements.humanGates ?? []) {
    const evaluation = candidateEvaluations.find((item) => item.evaluator === evaluatorId);
    if (!evaluation || evaluation.status !== "pass") {
      return { accepted: false, reason: `required human gate did not pass: ${evaluatorId}` };
    }
  }

  const baseline = flattenMetrics(baselineEvaluations)[config.primaryMetric];
  const candidate = flattenMetrics(candidateEvaluations)[config.primaryMetric];
  if (candidate === undefined) return { accepted: false, reason: `candidate did not produce metric ${config.primaryMetric}` };
  if (baseline === undefined) return { accepted: true, reason: "first measured baseline", candidateValue: candidate };

  const delta = config.direction === "maximize" ? candidate - baseline : baseline - candidate;
  const minimum = config.minimumDelta ?? 0;
  const printableDelta = Number(delta.toPrecision(8));
  const accepted = config.comparison === "at-least" ? delta >= minimum : delta > minimum;
  return accepted
    ? { accepted: true, reason: `met the ${config.primaryMetric} minimum delta with ${printableDelta}`, baselineValue: baseline, candidateValue: candidate }
    : { accepted: false, reason: `did not improve ${config.primaryMetric} by at least ${minimum}`, baselineValue: baseline, candidateValue: candidate };
}
