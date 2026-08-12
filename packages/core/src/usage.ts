export type UsageCostSource = "provider-reported" | "estimated";
export type UsageBillingMode = "subscription" | "credits" | "metered" | "unknown";
export type UsageIdentitySource = "provider-reported" | "configured";

export interface InvocationUsage {
  provider?: string;
  model?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  costSource?: UsageCostSource;
  pricingVersion?: string;
  billingMode?: UsageBillingMode;
  identitySource?: UsageIdentitySource;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    throw new Error(`usage.${field} must be a non-empty string with at most 256 characters`);
  }
  return value.trim();
}

function optionalTokenCount(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`usage.${field} must be a non-negative safe integer`);
  }
  return Number(value);
}

export function parseInvocationUsage(
  value: unknown,
  defaults: Pick<InvocationUsage, "provider" | "model" | "billingMode" | "identitySource"> = {}
): InvocationUsage | undefined {
  if (value === undefined && !defaults.provider && !defaults.model && !defaults.billingMode && !defaults.identitySource) return undefined;
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new Error("usage must be an object");
  }
  const record = (value ?? {}) as Record<string, unknown>;
  const costUsd = record.costUsd;
  if (costUsd !== undefined && (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0)) {
    throw new Error("usage.costUsd must be a non-negative finite number");
  }
  const costSource = record.costSource;
  if (costSource !== undefined && costSource !== "provider-reported" && costSource !== "estimated") {
    throw new Error("usage.costSource must be provider-reported or estimated");
  }
  const billingMode = record.billingMode ?? defaults.billingMode;
  if (billingMode !== undefined && billingMode !== "subscription" && billingMode !== "credits" && billingMode !== "metered" && billingMode !== "unknown") {
    throw new Error("usage.billingMode must be subscription, credits, metered, or unknown");
  }
  const identitySource = record.identitySource ?? defaults.identitySource;
  if (identitySource !== undefined && identitySource !== "provider-reported" && identitySource !== "configured") {
    throw new Error("usage.identitySource must be provider-reported or configured");
  }
  const result: InvocationUsage = {};
  const provider = optionalString(record.provider, "provider") ?? defaults.provider;
  const model = optionalString(record.model, "model") ?? defaults.model;
  const pricingVersion = optionalString(record.pricingVersion, "pricingVersion");
  if (provider) result.provider = provider;
  if (model) result.model = model;
  if (pricingVersion) result.pricingVersion = pricingVersion;
  for (const field of ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens"] as const) {
    const count = optionalTokenCount(record[field], field);
    if (count !== undefined) result[field] = count;
  }
  if (typeof costUsd === "number") result.costUsd = costUsd;
  if (costSource) result.costSource = costSource;
  if (billingMode) result.billingMode = billingMode;
  if (identitySource) result.identitySource = identitySource;
  return Object.keys(result).length > 0 ? result : undefined;
}

export function invocationTokenTotal(usage: InvocationUsage | undefined): number | undefined {
  if (!usage) return undefined;
  if (usage.totalTokens !== undefined) return usage.totalTokens;
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return undefined;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

export function aggregateInvocationUsage(usages: Array<InvocationUsage | undefined>): InvocationUsage | undefined {
  const reported = usages.filter((usage): usage is InvocationUsage => usage !== undefined);
  if (reported.length === 0) return undefined;
  const result: InvocationUsage = {};
  const sum = (field: "inputTokens" | "cachedInputTokens" | "outputTokens" | "reasoningTokens"): number | undefined => {
    const values = reported.map((usage) => usage[field]).filter((value): value is number => value !== undefined);
    return values.length > 0 ? values.reduce((total, value) => total + value, 0) : undefined;
  };
  for (const field of ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens"] as const) {
    const value = sum(field);
    if (value !== undefined) result[field] = value;
  }
  const totals = reported.map(invocationTokenTotal).filter((value): value is number => value !== undefined);
  if (totals.length === usages.length) result.totalTokens = totals.reduce((total, value) => total + value, 0);
  const costs = reported.map((usage) => usage.costUsd).filter((value): value is number => value !== undefined);
  if (costs.length === usages.length) result.costUsd = costs.reduce((total, value) => total + value, 0);
  const common = (field: "provider" | "model" | "costSource" | "pricingVersion" | "billingMode" | "identitySource"): string | undefined => {
    const values = [...new Set(reported.map((usage) => usage[field]).filter((value): value is string => value !== undefined))];
    return values.length === 1 ? values[0] : undefined;
  };
  const provider = common("provider");
  const model = common("model");
  const costSource = common("costSource") as UsageCostSource | undefined;
  const pricingVersion = common("pricingVersion");
  const billingMode = common("billingMode") as UsageBillingMode | undefined;
  const identitySource = common("identitySource") as UsageIdentitySource | undefined;
  if (provider) result.provider = provider;
  if (model) result.model = model;
  if (costSource) result.costSource = costSource;
  if (pricingVersion) result.pricingVersion = pricingVersion;
  if (billingMode) result.billingMode = billingMode;
  if (identitySource) result.identitySource = identitySource;
  return result;
}
