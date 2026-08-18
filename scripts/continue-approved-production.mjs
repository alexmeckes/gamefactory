import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AgentTeam } from "../extensions/agent-team/dist/index.js";
import { GodotEvidenceAgent } from "../extensions/godot/dist/index.js";
import { JsonlTraceStore } from "../packages/core/dist/index.js";

const projectRoot = resolve(process.argv[2] ?? "D:/GameFactory/projects/the-long-company");
const dataRoot = resolve(process.argv[3] ?? "D:/GameFactory/data");
const campaignTemplatePath = resolve(process.argv[4] ?? "games/the-long-company/campaign.json");
const runId = process.argv[5] ?? "the-long-company-approved-production-recovery-v1";
const reviewOnly = process.argv.includes("--review-only");
const experimentId = "approved-production-continuation";

const campaign = JSON.parse(await readFile(campaignTemplatePath, "utf8"));
campaign.id = runId;
campaign.projectRoot = projectRoot;
campaign.budget = { maximumExperiments: 1, wallTimeMinutes: 480 };

const originalGraph = campaign.parameters.agentTeam.graph;
const wanted = new Set([
  ...(reviewOnly ? [] : ["production-slice-builder"]),
  "evidence-auditor",
  "component-fidelity-gate",
  "art-director-gate",
  "production-judge"
]);
const nodes = originalGraph.nodes.filter((node) => wanted.has(node.id)).map((node) => structuredClone(node));
const byId = new Map(nodes.map((node) => [node.id, node]));

const builder = byId.get("production-slice-builder");
if (builder) {
  builder.dependsOn = [];
  delete builder.when;
  builder.instructions = `This is a continuation from a fail-closed asset-processing interruption, not a new visual exploration. The whole-scene target in design/scene-targets/scene-target.json is already independently approved. The two Omni motion studies have already been tracked and compiled into Godot SpriteFrames under design/asset-lanes/generated/pixel-motion. Do not rerun ImageGen, Omni, SAM3, or visual direction. Preserve the approved Veteran Dossier Ledger composition, integrate the compiled motion selectively, and finish the real runtime, captures, design system, component lineage, and polish manifest.\n\n${builder.instructions}`;
}

const evidenceAuditor = byId.get("evidence-auditor");
evidenceAuditor.dependsOn = reviewOnly ? [] : ["production-slice-builder"];
if (reviewOnly) delete evidenceAuditor.refreshAfterRepair;

const componentGate = byId.get("component-fidelity-gate");
componentGate.dependsOn = reviewOnly ? ["evidence-auditor"] : ["production-slice-builder", "evidence-auditor"];
componentGate.instructions = `The approved authority is the on-disk gamefactory.scene-target/v1 manifest and its selected target hash; no upstream scene-gate node is rerun in this recovery continuation. ${componentGate.instructions}`;

const artDirectorGate = byId.get("art-director-gate");
const productionJudge = byId.get("production-judge");
if (reviewOnly) {
  delete componentGate.repair;
  delete artDirectorGate.repair;
  delete productionJudge.repair;
  artDirectorGate.dependsOn = ["evidence-auditor", "component-fidelity-gate"];
  productionJudge.dependsOn = ["evidence-auditor", "component-fidelity-gate", "art-director-gate"];
}

campaign.parameters.agentTeam.maximumParallel = 1;
campaign.parameters.agentTeam.graph = {
  maximumTotalAttempts: reviewOnly ? 4 : 18,
  maximumRepairAttempts: reviewOnly ? 0 : 7,
  context: [
    ...originalGraph.context,
    { path: "design/scene-targets/scene-target.json", kind: "other", mediaType: "application/json", label: "Approved whole-scene target" },
    { path: "design/asset-lanes/decision.json", kind: "other", mediaType: "application/json", label: "Approved asset-lane decision" },
    { path: "design/asset-lanes/generated/pixel-motion/aldric-event-08-second-loss/pixel-motion.json", kind: "other", mediaType: "application/json", label: "Compiled Aldric fall animation" },
    { path: "design/asset-lanes/generated/pixel-motion/aldric-chronicle-to-memorial/pixel-motion.json", kind: "other", mediaType: "application/json", label: "Compiled memorial transition" }
  ],
  nodes
};

const tracePath = resolve(dataRoot, ".factory", "traces", `${runId}.jsonl`);
const traceStore = new JsonlTraceStore(tracePath);
const trace = {
  runId,
  campaignId: campaign.id,
  emit: async (event) => { await traceStore.append({ runId, campaignId: campaign.id }, event); }
};
const rootNodeId = `campaign:${runId}`;
await trace.emit({ type: "node:created", nodeId: rootNodeId, label: "The Long Company approved production continuation", role: "campaign" });
await trace.emit({ type: "node:started", nodeId: rootNodeId, label: "The Long Company approved production continuation", role: "campaign" });

const godotEvidence = new GodotEvidenceAgent();
const team = new AgentTeam((id) => {
  if (id === "godot.evidence") return godotEvidence;
  throw new Error(`Recovery continuation cannot resolve agent driver ${id}`);
});
const startedAt = new Date().toISOString();
let result;
try {
  result = await team.run({
    campaign,
    candidate: { id: experimentId, root: projectRoot, metadata: { recovery: true } },
    experimentId,
    history: [],
    signal: new AbortController().signal,
    trace
  });
  await trace.emit({ type: "node:completed", nodeId: rootNodeId, label: "The Long Company approved production continuation", role: "campaign", status: "complete", message: result.summary });
} catch (error) {
  await trace.emit({ type: "node:failed", nodeId: rootNodeId, label: "The Long Company approved production continuation", role: "campaign", status: "failed", message: error instanceof Error ? error.message : String(error) });
  throw error;
}

const outputPath = resolve(dataRoot, ".factory", "results", `${runId}.json`);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify({ campaignId: campaign.id, experimentId, startedAt, finishedAt: new Date().toISOString(), summary: result.summary, contributors: result.contributors, artifacts: result.artifacts, metadata: result.metadata }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ status: "complete", campaignId: campaign.id, summary: result.summary, contributors: result.contributors?.length ?? 0, artifacts: result.artifacts?.length ?? 0, tracePath, outputPath }, null, 2));
