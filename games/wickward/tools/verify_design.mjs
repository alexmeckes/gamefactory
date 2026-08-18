import { resolve } from "node:path";
import { DesignSystemEvaluator } from "../../../extensions/design-lab/dist/index.js";

const root = resolve(import.meta.dirname, "..");
const campaign = {
  apiVersion: "gamefactory.dev/v1",
  id: "wickward-production-slice",
  objective: "Verify Wickward's captured Godot production slice",
  projectRoot: root,
  workflow: "tournament",
  requires: [],
  parameters: {
    designSystem: {
      path: "design-system.json",
      visualDirectionPath: "visual-direction.json",
      minimumMaturity: "production-slice",
      requiredTokenGroups: ["color", "typography", "layout", "motion"],
      requiredAdapters: ["godot-production-slice", "production-readiness"],
      requiredReferenceAuthorities: ["production-target"],
      requiredPolishGates: ["engine-capture", "gameplay-readability", "art-direction", "interface-system", "motion-choreography", "interaction-states", "technical-style"],
      requireProductionReadiness: true,
      requireNoPlaceholders: true
    }
  },
  acceptance: { primaryMetric: "polish_ready", direction: "maximize" }
};

const evaluation = await new DesignSystemEvaluator().evaluate({
  campaign,
  candidate: { id: "wickward", root, metadata: {} },
  experimentId: "wickward-final",
  priorEvaluations: [],
  signal: new AbortController().signal
});

console.log(JSON.stringify({
  status: evaluation.status,
  metrics: evaluation.metrics,
  violations: evaluation.violations,
  artifacts: evaluation.artifacts.map((artifact) => artifact.path)
}, null, 2));
if (evaluation.status !== "pass") process.exitCode = 1;
