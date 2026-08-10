import { readFile, writeFile } from "node:fs/promises";

const path = new URL("../tuning.json", import.meta.url);
const tuning = JSON.parse(await readFile(path, "utf8"));
tuning.fun_score = Number((Number(tuning.fun_score ?? 0.5) + 0.05).toFixed(4));
await writeFile(path, `${JSON.stringify(tuning, null, 2)}\n`, "utf8");
console.log(`Raised deterministic fun_score to ${tuning.fun_score}`);
