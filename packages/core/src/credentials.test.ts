import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { LocalCredentialStore, resolveCredential, type CredentialCipher } from "./credentials.js";

class FixtureCipher implements CredentialCipher {
  async seal(value: string): Promise<string> { return Buffer.from(value, "utf8").toString("base64"); }
  async unseal(value: string): Promise<string> { return Buffer.from(value, "base64").toString("utf8"); }
}

test("local credential store returns values without placing plaintext in its records", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-credentials-"));
  const store = new LocalCredentialStore({ root, cipher: new FixtureCipher() });
  try {
    await store.set("google.gemini", "top-secret-value");
    assert.equal(await store.get("google.gemini"), "top-secret-value");
    assert.deepEqual(await store.list(), ["google.gemini"]);
    const stored = (await Promise.all((await readdir(root)).map((file) => readFile(resolve(root, file), "utf8")))).join("\n");
    assert.doesNotMatch(stored, /top-secret-value/);
    assert.equal(await store.remove("google.gemini"), true);
    assert.equal(await store.get("google.gemini"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("credential resolution prefers an explicit environment variable", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gamefactory-credentials-"));
  const store = new LocalCredentialStore({ root, cipher: new FixtureCipher() });
  const previous = process.env.GAMEFACTORY_TEST_API_KEY;
  try {
    await store.set("provider.key", "stored");
    process.env.GAMEFACTORY_TEST_API_KEY = "environment";
    assert.deepEqual(await resolveCredential("provider.key", "GAMEFACTORY_TEST_API_KEY", store), { value: "environment", source: "environment" });
  } finally {
    if (previous === undefined) delete process.env.GAMEFACTORY_TEST_API_KEY;
    else process.env.GAMEFACTORY_TEST_API_KEY = previous;
    await rm(root, { recursive: true, force: true });
  }
});
