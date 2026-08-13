import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerPool } from "../extensions/agent-team/dist/codex-app-server.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const ROUTING_PROFILES = [
  { id: "luna-high", model: "gpt-5.6-luna", reasoningEffort: "high" },
  { id: "sol-medium", model: "gpt-5.6-sol", reasoningEffort: "medium" },
  { id: "sol-high", model: "gpt-5.6-sol", reasoningEffort: "high" },
  { id: "sol-xhigh", model: "gpt-5.6-sol", reasoningEffort: "xhigh" }
];

export const BENCHMARK_TASKS = [
  {
    id: "rope-system-audit",
    prompt: [
      "Audit this small Godot rope-puzzle fixture. Identify the four distinct player-facing correctness or legibility defects encoded in the files.",
      "Return outcome `complete`. In payload, include `findings` as concise defect objects with evidence paths and `recommendation` as a prioritized fix order.",
      "Do not modify files. Do not merely repeat the product brief; ground every finding in repository evidence."
    ].join("\n\n"),
    files: {
      "AGENTS.md": "Read-only benchmark fixture. Inspect all supplied files and return evidence-grounded findings.\n",
      "src/rope_integrator.gd": "extends RefCounted\nconst REST_LENGTH := 12.0\nfunc correction(a: Vector2, b: Vector2) -> Vector2:\n\tvar delta := b - a\n\tvar direction := delta / delta.length()\n\treturn direction * ((delta.length() - REST_LENGTH) * 0.5)\n",
      "src/knot_detector.gd": "extends RefCounted\nfunc matches_target(points: PackedVector2Array, post: Vector2) -> bool:\n\treturn abs(winding_number(points, post)) > 0.75 and silhouette_error(points) < 18.0\n# winding_number and silhouette_error are deterministic helpers. Crossing order is not sampled.\n",
      "src/drag_controller.gd": "extends Node\nfunc begin_drag(mouse: Vector2, rope_points: PackedVector2Array) -> void:\n\tgrabbed_index = nearest_point_index(mouse, rope_points)\n\t# There is no maximum grab radius; a click anywhere selects some rope point.\n",
      "STYLE_CONTRACT.md": "The rope is rendered as one uninterrupted constant-width Line2D. Crossings have no gap, shadow, bridge, or over/under marker. The target language requires players to reason about threading direction.\n"
    },
    concepts: [
      ["zero length", "division by zero", "non-finite", "nan"],
      ["crossing order", "over/under", "over-under", "topolog"],
      ["grab radius", "maximum distance", "click anywhere", "nearest point"],
      ["crossing", "gap", "bridge", "occlusion", "legibility"]
    ],
    evidence: ["src/rope_integrator.gd", "src/knot_detector.gd", "src/drag_controller.gd", "STYLE_CONTRACT.md"]
  },
  {
    id: "orchestration-safety-audit",
    prompt: [
      "Audit this factory graph and its runtime notes. Identify the four independent orchestration/recovery hazards and propose a safe execution order or invariant for each.",
      "Return outcome `complete`. In payload, include `findings` with evidence paths and a `recommendation` field.",
      "Do not modify files. Prefer exact causal reasoning over generic agent-system advice."
    ].join("\n\n"),
    files: {
      "AGENTS.md": "Read-only benchmark fixture. Inspect all supplied files and return evidence-grounded findings.\n",
      "pipeline.json": JSON.stringify({
        nodes: [
          { id: "systems-scout", permissions: "read" },
          { id: "style-scout", permissions: "read" },
          { id: "builder", permissions: "write", dependsOn: ["systems-scout"] },
          { id: "critic", permissions: "read", dependsOn: ["builder"], repair: { target: "builder" } }
        ]
      }, null, 2),
      "recovery-policy.md": "On artifact preservation failure, the current prototype discards the candidate and records it as cleaned. Desired invariant: evidence failures retain the candidate and block finalization.\n",
      "acceptance-policy.md": "Acceptance cherry-picks the candidate revision without comparing the repository's current HEAD to the base HEAD captured when the candidate was created.\n",
      "runtime-notes.md": "Cleanup reuses the already-aborted campaign signal. A cancelled run can therefore skip worktree removal and leave reconciliation state behind.\n"
    },
    concepts: [
      ["style-scout", "missing dependency", "depends on both", "dependency"],
      ["retain", "preservation", "evidence", "block"],
      ["base head", "expected head", "compare head", "repository head"],
      ["cleanup signal", "independent signal", "aborted signal", "bounded cleanup"]
    ],
    evidence: ["pipeline.json", "recovery-policy.md", "acceptance-policy.md", "runtime-notes.md"]
  }
];

function normalized(value) {
  return JSON.stringify(value).toLowerCase();
}

export function scoreResponse(task, response) {
  const text = normalized(response);
  const conceptHits = task.concepts.map((alternatives) => alternatives.some((term) => text.includes(term)));
  const evidenceHits = task.evidence.map((path) => text.includes(path.toLowerCase()));
  const recommendation = response && typeof response === "object" ? response.recommendation : undefined;
  const recommendationText = typeof recommendation === "string" ? recommendation : normalized(recommendation ?? "");
  const conceptScore = conceptHits.filter(Boolean).length * 15;
  const evidenceScore = evidenceHits.filter(Boolean).length * 5;
  const structureScore = response?.outcome === "complete" ? 5 : 0;
  const recommendationScore = recommendationText.length >= 80 ? 15 : recommendationText.length >= 30 ? 8 : 0;
  return {
    score: Math.min(100, conceptScore + evidenceScore + structureScore + recommendationScore),
    conceptHits,
    evidenceHits,
    recommendationScore
  };
}

function aggregate(samples, profile) {
  const successful = samples.filter((sample) => sample.profileId === profile.id && !sample.error && sample.routingMatched !== false);
  const all = samples.filter((sample) => sample.profileId === profile.id);
  const sum = (key) => successful.reduce((total, sample) => total + (sample[key] ?? 0), 0);
  return {
    ...profile,
    runs: all.length,
    successfulRuns: successful.length,
    quality: all.length ? Number((all.reduce((total, sample) => total + sample.quality.score, 0) / all.length).toFixed(1)) : 0,
    latencyMs: successful.length ? Math.round(sum("latencyMs") / successful.length) : null,
    totalTokens: sum("totalTokens"),
    inputTokens: sum("inputTokens"),
    cachedInputTokens: sum("cachedInputTokens"),
    outputTokens: sum("outputTokens"),
    reasoningTokens: sum("reasoningTokens")
  };
}

export function rankProfiles(aggregates) {
  const pareto = aggregates.filter((candidate) => !aggregates.some((other) => other.id !== candidate.id
    && other.quality >= candidate.quality
    && (other.latencyMs ?? Infinity) <= (candidate.latencyMs ?? Infinity)
    && other.totalTokens <= candidate.totalTokens
    && (other.quality > candidate.quality || (other.latencyMs ?? Infinity) < (candidate.latencyMs ?? Infinity) || other.totalTokens < candidate.totalTokens)));
  const bestQuality = Math.max(...aggregates.map((profile) => profile.quality));
  const nearBest = aggregates.filter((profile) => profile.successfulRuns === profile.runs && profile.quality >= bestQuality - 2);
  const recommended = [...nearBest].sort((left, right) => left.totalTokens - right.totalTokens || (left.latencyMs ?? Infinity) - (right.latencyMs ?? Infinity))[0]
    ?? [...aggregates].sort((left, right) => right.quality - left.quality || left.totalTokens - right.totalTokens)[0];
  return { paretoProfileIds: pareto.map((profile) => profile.id), recommendedProfileId: recommended?.id };
}

async function defaultLauncher() {
  if (process.env.GAMEFACTORY_CODEX_BINARY) return [process.env.GAMEFACTORY_CODEX_BINARY, "app-server", "--listen", "stdio://"];
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const binaryRoot = resolve(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
    try {
      const candidates = await Promise.all((await readdir(binaryRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const path = resolve(binaryRoot, entry.name, "codex.exe");
          const stats = await lstat(path).catch(() => undefined);
          return stats?.isFile() ? { path, modified: stats.mtimeMs } : undefined;
        }));
      const newest = candidates.filter(Boolean).sort((left, right) => right.modified - left.modified)[0];
      if (newest) return [newest.path, "app-server", "--listen", "stdio://"];
    } catch {
      // Fall through to PATH.
    }
  }
  return ["codex", "app-server", "--listen", "stdio://"];
}

async function createFixture(task) {
  const root = await mkdtemp(resolve(tmpdir(), `gamefactory-${task.id}-`));
  for (const [path, content] of Object.entries(task.files)) {
    const target = resolve(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${content}\n`, "utf8");
  }
  return root;
}

function parseArguments(argv) {
  const smoke = argv.includes("--smoke");
  const timeoutArgument = argv.find((value) => value.startsWith("--timeout-minutes="));
  const timeoutMinutes = timeoutArgument ? Number(timeoutArgument.split("=")[1]) : 30;
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) throw new Error("--timeout-minutes must be a positive number");
  return { smoke, timeoutMs: timeoutMinutes * 60_000 };
}

export async function runBenchmark(options = {}) {
  const profiles = options.profiles ?? ROUTING_PROFILES;
  const tasks = options.tasks ?? BENCHMARK_TASKS;
  const launcher = options.launcher ?? await defaultLauncher();
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  const pool = new CodexAppServerPool();
  const samples = [];
  const fixtureRoots = new Map();
  try {
    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
      const task = tasks[taskIndex];
      const root = await createFixture(task);
      fixtureRoots.set(task.id, root);
      const orderedProfiles = taskIndex % 2 === 0 ? profiles : [...profiles].reverse();
      for (const profile of orderedProfiles) {
        process.stdout.write(`\n[${task.id}] ${profile.id} (${profile.model}, ${profile.reasoningEffort})\n`);
        const started = performance.now();
        try {
          const result = await pool.run({
            launcher,
            cwd: root,
            prompt: task.prompt,
            readOnly: true,
            model: profile.model,
            reasoningEffort: profile.reasoningEffort,
            signal: new AbortController().signal,
            timeoutMs,
            environment: process.env,
            onEvent: (event) => {
              if (event.method === "turn/started") process.stdout.write("turn-started ");
              if (event.method === "item/started") {
                const item = event.params.item && typeof event.params.item === "object" ? event.params.item : {};
                process.stdout.write(`${typeof item.type === "string" ? item.type : "item"} `);
              }
            }
          });
          const response = JSON.parse(result.output);
          const latencyMs = Math.round(performance.now() - started);
          const quality = scoreResponse(task, response);
          const routingMatched = result.actualModel === profile.model && result.reasoningEffort === profile.reasoningEffort;
          const sample = {
            taskId: task.id,
            profileId: profile.id,
            requestedModel: profile.model,
            actualModel: result.actualModel,
            requestedReasoningEffort: profile.reasoningEffort,
            actualReasoningEffort: result.reasoningEffort,
            latencyMs,
            quality,
            inputTokens: result.usage?.inputTokens ?? 0,
            cachedInputTokens: result.usage?.cachedInputTokens ?? 0,
            outputTokens: result.usage?.outputTokens ?? 0,
            reasoningTokens: result.usage?.reasoningTokens ?? 0,
            totalTokens: result.usage?.totalTokens ?? 0,
            billingMode: result.usage?.billingMode ?? "subscription",
            routingMatched,
            response
          };
          samples.push(sample);
          process.stdout.write(`quality=${quality.score} latency=${latencyMs}ms tokens=${sample.totalTokens} resolved=${result.actualModel}/${result.reasoningEffort ?? "unreported"} routing=${routingMatched ? "matched" : "MISMATCH"}\n`);
        } catch (error) {
          const latencyMs = Math.round(performance.now() - started);
          samples.push({
            taskId: task.id,
            profileId: profile.id,
            requestedModel: profile.model,
            requestedReasoningEffort: profile.reasoningEffort,
            latencyMs,
            quality: { score: 0, conceptHits: [], evidenceHits: [], recommendationScore: 0 },
            totalTokens: 0,
            error: error instanceof Error ? error.message : String(error)
          });
          process.stdout.write(`failed after ${latencyMs}ms: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
    }
  } finally {
    await pool.dispose();
    await Promise.all([...fixtureRoots.values()].map((root) => rm(root, { recursive: true, force: true })));
  }
  const profilesSummary = profiles.map((profile) => aggregate(samples, profile));
  const ranking = rankProfiles(profilesSummary);
  return {
    reportVersion: 1,
    executedAt: new Date().toISOString(),
    billingMode: "subscription",
    dimensions: ["quality", "latencyMs", "totalTokens"],
    scoringPolicy: "Deterministic evidence-and-concept rubric; recommend the lowest-token profile within two quality points of the best complete profile.",
    tasks: tasks.map(({ id, concepts, evidence }) => ({ id, conceptCount: concepts.length, evidence })),
    profiles: profilesSummary,
    ...ranking,
    samples
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const report = await runBenchmark({ tasks: args.smoke ? BENCHMARK_TASKS.slice(0, 1) : BENCHMARK_TASKS, timeoutMs: args.timeoutMs });
  const outputDirectory = resolve(repositoryRoot, ".factory", "benchmarks");
  await mkdir(outputDirectory, { recursive: true });
  const timestamp = report.executedAt.replaceAll(":", "-");
  const timestampedPath = resolve(outputDirectory, `model-routing-${timestamp}.json`);
  const latestPath = resolve(outputDirectory, "model-routing-latest.json");
  const contents = `${JSON.stringify(report, null, 2)}\n`;
  await Promise.all([writeFile(timestampedPath, contents, "utf8"), writeFile(latestPath, contents, "utf8")]);
  console.table(report.profiles.map((profile) => ({
    profile: profile.id,
    quality: profile.quality,
    latencyMs: profile.latencyMs,
    totalTokens: profile.totalTokens,
    reasoningTokens: profile.reasoningTokens
  })));
  console.log(`Pareto frontier: ${report.paretoProfileIds.join(", ")}`);
  console.log(`Recommended: ${report.recommendedProfileId ?? "none"}`);
  console.log(`Report: ${timestampedPath}`);
  if (report.profiles.some((profile) => profile.successfulRuns !== profile.runs)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
