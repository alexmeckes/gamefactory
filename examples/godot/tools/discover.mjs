import { readFile, writeFile } from "node:fs/promises";

const request = JSON.parse(await readFile(process.env.GAMEFACTORY_REQUEST, "utf8"));
const tuningUrl = new URL("../tuning.json", import.meta.url);
const tuning = JSON.parse(await readFile(tuningUrl, "utf8"));
const slot = Number(String(request.experimentId).match(/p(\d+)$/)?.[1] ?? 1);

const prototypes = [
  {
    id: "mobility-expression",
    description: "Increase correction authority so deliberate route changes remain possible under pressure.",
    apply() { tuning.player_speed = Number((Number(tuning.player_speed) + 35).toFixed(2)); }
  },
  {
    id: "readable-threats",
    description: "Slow drone traversal slightly to widen the read-and-react window.",
    apply() { tuning.hazard_speed = Number(Math.max(35, Number(tuning.hazard_speed) - 14).toFixed(2)); }
  },
  {
    id: "richer-routing",
    description: "Add simultaneous rewards to create more route choice in each arena state.",
    apply() { tuning.pickup_count = Number(tuning.pickup_count) + 2; }
  }
];

const prototype = prototypes[(slot - 1) % prototypes.length];
prototype.apply();
await writeFile(tuningUrl, `${JSON.stringify(tuning, null, 2)}\n`, "utf8");
console.log(`${prototype.id}: ${prototype.description}`);
