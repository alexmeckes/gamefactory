import { readFile, writeFile } from "node:fs/promises";

const request = JSON.parse(await readFile(process.env.GAMEFACTORY_REQUEST, "utf8"));
const stage = String(request.stage);
const contributor = String(request.contributorId);

if (stage === "scout") {
  console.log(`${contributor}: inspect Pulse Runner's collection, survival, and movement metrics; keep changes inside tuning.json.`);
} else if (stage === "planner") {
  console.log(`${contributor}: choose a candidate-specific player-speed change, preserve the scenario contract, and touch only tuning.json.`);
} else if (stage === "implementer") {
  const tuningUrl = new URL("../tuning.json", import.meta.url);
  const tuning = JSON.parse(await readFile(tuningUrl, "utf8"));
  const slot = Number(request.experimentId.match(/c(\d+)$/)?.[1] ?? 1);
  const increments = [25, 60, 40];
  const increment = increments[(slot - 1) % increments.length];
  tuning.player_speed = Number((Number(tuning.player_speed ?? 230) + increment).toFixed(2));
  await writeFile(tuningUrl, `${JSON.stringify(tuning, null, 2)}\n`, "utf8");
  console.log(`${contributor}: raised player_speed by ${increment} to ${tuning.player_speed}.`);
} else if (stage === "critic") {
  const tuning = JSON.parse(await readFile(new URL("../tuning.json", import.meta.url), "utf8"));
  console.log(`${contributor}: candidate remains bounded and proposes player_speed=${tuning.player_speed}.`);
} else {
  throw new Error(`Unsupported team stage: ${stage}`);
}
