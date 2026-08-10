import { readFile, writeFile } from "node:fs/promises";

const request = JSON.parse(await readFile(process.env.GAMEFACTORY_REQUEST, "utf8"));
const stage = String(request.stage);
const contributor = String(request.contributorId);

if (stage === "scout") {
  console.log(`${contributor}: the deterministic score is isolated in tuning.json; change only that bounded surface.`);
} else if (stage === "planner") {
  console.log(`${contributor}: choose a candidate-specific increment, preserve the scenario contract, and touch only tuning.json.`);
} else if (stage === "implementer") {
  const tuningUrl = new URL("../tuning.json", import.meta.url);
  const tuning = JSON.parse(await readFile(tuningUrl, "utf8"));
  const slot = Number(request.experimentId.match(/c(\d+)$/)?.[1] ?? 1);
  const increments = [0.03, 0.08, 0.05];
  const increment = increments[(slot - 1) % increments.length];
  tuning.fun_score = Number((Number(tuning.fun_score ?? 0.5) + increment).toFixed(4));
  await writeFile(tuningUrl, `${JSON.stringify(tuning, null, 2)}\n`, "utf8");
  console.log(`${contributor}: raised fun_score by ${increment} to ${tuning.fun_score}.`);
} else if (stage === "critic") {
  const tuning = JSON.parse(await readFile(new URL("../tuning.json", import.meta.url), "utf8"));
  console.log(`${contributor}: candidate remains bounded and proposes fun_score=${tuning.fun_score}.`);
} else {
  throw new Error(`Unsupported team stage: ${stage}`);
}
