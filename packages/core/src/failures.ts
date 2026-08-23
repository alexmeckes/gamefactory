export type FailureClass = "infrastructure" | "execution" | "validation";

/**
 * Marks a failure in orchestration, adapters, persistence, or host tooling.
 * Workflows use this signal to retain recoverable candidate state without
 * counting the failure as a creative experiment or gameplay rejection.
 */
export class InfrastructureFailureError extends Error {
  readonly name: string = "InfrastructureFailureError";
  readonly failureClass = "infrastructure" as const;

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
  }
}

/**
 * Marks a candidate that was honestly rejected by trusted review or evidence.
 * The candidate must not be promoted or reused unchanged, but it is retained as
 * the bounded repair base and the failed attempt still consumes creative budget.
 */
export class CandidateInvalidatedError extends Error {
  readonly name: string = "CandidateInvalidatedError";
  readonly failureClass = "validation" as const;

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
  }
}

export function isInfrastructureFailure(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { failureClass?: unknown }).failureClass === "infrastructure");
}

export function isCandidateInvalidation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { failureClass?: unknown }).failureClass === "validation");
}

export function shouldRetainCandidate(error: unknown): boolean {
  return isInfrastructureFailure(error) || isCandidateInvalidation(error);
}
