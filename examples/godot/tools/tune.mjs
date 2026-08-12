import { readFile, writeFile } from "node:fs/promises";

const path = new URL("../tuning.json", import.meta.url);
const tuning = JSON.parse(await readFile(path, "utf8"));
tuning.player_speed = Number((Number(tuning.player_speed ?? 230) + 40).toFixed(2));
await writeFile(path, `${JSON.stringify(tuning, null, 2)}\n`, "utf8");
console.log(`Raised Pulse Runner player_speed to ${tuning.player_speed}`);
