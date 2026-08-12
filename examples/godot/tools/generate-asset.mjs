import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const requestPath = process.env.GAMEFACTORY_ASSET_REQUEST;
const resultPath = process.env.GAMEFACTORY_ASSET_RESULT;
if (!requestPath || !resultPath) throw new Error("Expected GAMEFACTORY_ASSET_REQUEST and GAMEFACTORY_ASSET_RESULT");

const request = JSON.parse(await readFile(requestPath, "utf8"));
const recipesPath = resolve(request.candidateRoot, "asset-sources", "recipes.json");
const recipes = JSON.parse(await readFile(recipesPath, "utf8"));
const recipe = recipes[(Number(request.candidateSlot) - 1) % recipes.length];
if (!recipe) throw new Error(`No asset recipe for candidate slot ${request.candidateSlot}`);

const source = resolve(request.candidateRoot, "asset-sources", recipe.file);
await mkdir(dirname(request.outputPath), { recursive: true });
await copyFile(source, request.outputPath);
await writeFile(resultPath, `${JSON.stringify({
  generator: { id: "openai.imagegen.builtin", model: "built-in-default" },
  prompt: recipe.prompt,
  source: recipe.rawSource,
  license: "generated-output-rights-unverified",
  processors: [{
    id: "imagegen.remove-chroma-key",
    parameters: {
      autoKey: "border",
      softMatte: true,
      transparentThreshold: 12,
      opaqueThreshold: 220,
      despill: true
    }
  }],
  metadata: { variantId: recipe.id, fixtureSource: recipe.file }
}, null, 2)}\n`, "utf8");

console.log(`Generated ${request.brief.id} from ${recipe.id}`);
