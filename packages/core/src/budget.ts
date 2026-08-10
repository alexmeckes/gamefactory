import type { BudgetConfig, BudgetControllerLike, BudgetReservationLike, ExperimentRecord } from "./types.js";

export class BudgetController implements BudgetControllerLike {
  readonly startedAt = Date.now();
  experiments = 0;
  consecutiveCrashes = 0;
  experimentsWithoutImprovement = 0;
  costUsd = 0;
  private reservedExperiments = 0;
  private reservedCostUsd = 0;
  private readonly reservations = new Set<string>();

  constructor(private readonly config: BudgetConfig = {}) {}

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  canStart(requestedExperiments = 1): { allowed: boolean; reason?: string } {
    if (!Number.isInteger(requestedExperiments) || requestedExperiments < 1) throw new Error("requestedExperiments must be a positive integer");
    if (this.config.maximumExperiments !== undefined && this.experiments + this.reservedExperiments + requestedExperiments > this.config.maximumExperiments) {
      return { allowed: false, reason: "maximum experiments reached" };
    }
    if (this.config.wallTimeMinutes !== undefined && this.elapsedMs() >= this.config.wallTimeMinutes * 60_000) {
      return { allowed: false, reason: "wall-time budget reached" };
    }
    if (this.config.maximumConsecutiveCrashes !== undefined && this.consecutiveCrashes >= this.config.maximumConsecutiveCrashes) {
      return { allowed: false, reason: "consecutive crash limit reached" };
    }
    if (this.config.maximumCostUsd !== undefined && this.costUsd + this.reservedCostUsd >= this.config.maximumCostUsd) {
      return { allowed: false, reason: "cost budget reached" };
    }
    if (this.config.plateauExperiments !== undefined && this.experimentsWithoutImprovement >= this.config.plateauExperiments) {
      return { allowed: false, reason: "improvement plateau reached" };
    }
    return { allowed: true };
  }

  remainingExperiments(): number {
    return this.config.maximumExperiments === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, this.config.maximumExperiments - this.experiments - this.reservedExperiments);
  }

  tryReserve(input: { experimentId: string; estimatedCostUsd?: number }): BudgetReservationLike | undefined {
    if (this.reservations.has(input.experimentId)) throw new Error(`Experiment already reserved: ${input.experimentId}`);
    const estimatedCostUsd = input.estimatedCostUsd ?? 0;
    if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) throw new Error("estimatedCostUsd must be a non-negative finite number");
    if (!this.canStart().allowed) return undefined;
    if (this.config.maximumCostUsd !== undefined && this.costUsd + this.reservedCostUsd + estimatedCostUsd > this.config.maximumCostUsd) return undefined;
    this.reservations.add(input.experimentId);
    this.reservedExperiments += 1;
    this.reservedCostUsd += estimatedCostUsd;
    let settled = false;
    const release = () => {
      if (settled) return false;
      settled = true;
      this.reservations.delete(input.experimentId);
      this.reservedExperiments -= 1;
      this.reservedCostUsd -= estimatedCostUsd;
      return true;
    };
    return {
      experimentId: input.experimentId,
      get settled() { return settled; },
      settle: (result) => {
        if (!release()) return;
        this.record({ status: result.status, ...(result.actualCostUsd !== undefined ? { costUsd: result.actualCostUsd } : {}) });
      },
      cancel: () => { release(); }
    };
  }

  record(input: { status: ExperimentRecord["status"]; costUsd?: number }): void {
    if (input.status !== "baseline" && input.status !== "cancelled") this.experiments += 1;
    this.consecutiveCrashes = input.status === "crash" ? this.consecutiveCrashes + 1 : 0;
    this.experimentsWithoutImprovement = input.status === "keep"
      ? 0
      : input.status === "baseline" || input.status === "cancelled"
        ? this.experimentsWithoutImprovement
        : this.experimentsWithoutImprovement + 1;
    this.costUsd += input.costUsd ?? 0;
  }
}
