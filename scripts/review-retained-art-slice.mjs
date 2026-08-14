import { resolve } from "node:path";
import { loadCampaign } from "../packages/core/dist/index.js";
import { AgentTeam } from "../extensions/agent-team/dist/index.js";
import { DesignSystemEvaluator } from "../extensions/design-lab/dist/index.js";
import { GodotVisualEvaluator } from "../extensions/godot/dist/index.js";

const candidateRoot = resolve(process.argv[2] ?? "");
const campaignPath = resolve(process.argv[3] ?? "games/firefly-glassworks/campaign.art-slice.json");
if (!process.argv[2]) throw new Error("Usage: node scripts/review-retained-art-slice.mjs <candidate-root> [campaign.json]");

const campaign = await loadCampaign(campaignPath);
const evaluateOnlyIndex = process.argv.indexOf("--evaluate-only");
const experimentId = evaluateOnlyIndex >= 0
  ? process.argv[evaluateOnlyIndex + 1]
  : `retained-art-review-${Date.now()}`;
if (!experimentId) throw new Error("--evaluate-only requires an experiment id");
const originalAgentTeam = campaign.parameters?.agentTeam ?? {};
const reviewCampaign = {
  ...campaign,
  projectRoot: candidateRoot,
  parameters: {
    ...campaign.parameters,
    agentTeam: {
      ...originalAgentTeam,
      maximumParallel: 1,
      graph: {
        maximumTotalAttempts: 1,
        maximumRepairAttempts: 0,
        context: [
          { path: "GAME.md", kind: "other", mediaType: "text/markdown", label: "Product brief" },
          { path: "STYLE.md", kind: "other", mediaType: "text/markdown", label: "Visual direction" },
          { path: "visual-direction.json", kind: "other", mediaType: "application/json", label: "Typed visual contract" },
          { path: "design-system.json", kind: "other", mediaType: "application/json", label: "Candidate design system" },
          { path: "design/production-slice.json", kind: "other", mediaType: "application/json", label: "Candidate implementation manifest" },
          { path: "design/captures/first-puzzle.png", kind: "image", mediaType: "image/png", label: "Actionable running-game capture" },
          { path: "design/captures/solved.png", kind: "image", mediaType: "image/png", label: "Solved running-game capture" },
          ...Array.from({ length: 7 }, (_, index) => ({
            path: `design/captures/motion-00${index}.png`,
            kind: "image",
            mediaType: "image/png",
            label: `Running-game motion frame ${index + 1}`
          })),
          { path: "src/presentation_contract_runner.gd", kind: "other", mediaType: "text/plain", label: "Presentation contract" },
          { path: "main.gd", kind: "other", mediaType: "text/plain", label: "Playable implementation" }
        ],
        nodes: [{
          id: "art-slice-critic",
          adapter: "codex-app-server",
          model: "gpt-5.6-sol",
          reasoningEffort: "xhigh",
          timeoutSeconds: 1800,
          role: "critic",
          permissions: "read",
          instructions: "Independently review this repaired production slice using the supplied running-Godot stills, full seven-frame sequence, design contracts, and implementation. Verify that mirror art matches solver semantics and that beam reveal, contact, and receiver settling occur through the normal player-facing runtime path. Gate material separation, focal hierarchy, beam legibility, authored specificity, typography/composition, motion, accessibility, engine feasibility, and reuse. Return outcome pass or revise; findings.scorecard must contain numeric 0-100 material_depth, focal_hierarchy, beam_legibility, authored_specificity, composition_typography, and motion_feedback; findings.evidence must cover first-puzzle, solved, and beam-route; findings.blockingIssues must be an array. Do not claim human evidence of fun."
        }]
      }
    }
  }
};

const candidate = { id: "retained-art-slice", root: candidateRoot, metadata: { retained: true } };
const controller = new AbortController();
process.once("SIGINT", () => controller.abort(new Error("Interrupted")));

let result = { summary: "Used the already persisted independent critic output." };
if (evaluateOnlyIndex < 0) {
  const agent = new AgentTeam();
  result = await agent.run({
    campaign: reviewCampaign,
    candidate,
    experimentId,
    history: [],
    signal: controller.signal
  });
}
const design = await new DesignSystemEvaluator().evaluate({ campaign: reviewCampaign, candidate, experimentId, priorEvaluations: [], signal: controller.signal });
const visual = await new GodotVisualEvaluator().evaluate({ campaign: reviewCampaign, candidate, experimentId, priorEvaluations: [design], signal: controller.signal });

console.log(JSON.stringify({ experimentId, summary: result.summary, design, visual }, null, 2));
if (design.status !== "pass" || visual.status !== "pass") process.exitCode = 1;
