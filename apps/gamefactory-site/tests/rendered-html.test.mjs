import assert from "node:assert/strict";
import test from "node:test";

const workerUrl = new URL("../dist/server/index.js", import.meta.url);

async function worker() {
  const target = new URL(workerUrl);
  target.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  return (await import(target.href)).default;
}

const context = {
  waitUntil() {},
  passThroughOnException() {},
};

const assets = {
  fetch: async () => new Response("Not found", { status: 404 }),
};

test("renders the GameFactory observatory", async () => {
  const app = await worker();
  const response = await app.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: assets },
    context,
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>GameFactory Observatory<\/title>/i);
  assert.match(html, /Who did what, with which capabilities and creative inputs/);
  assert.match(html, /gamefactory\.asset-foundry/);
  assert.match(html, /pulse-runner-neon@1\.0\.0/);
  assert.match(html, /Creative inputs/);
  assert.match(html, /Portable replay/);
  assert.match(html, /Pulse Runner/);
  assert.match(html, /Included in plan/);
  assert.match(html, /Total tokens<\/span><strong>unreported/);
  assert.match(html, /models intentionally unreported/i);
  assert.doesNotMatch(html, /gpt-5\.4/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/);
});

test("does not expose a server-side bridge or tunnel route", async () => {
  const app = await worker();
  const response = await app.fetch(
    new Request("http://localhost/api/factory/snapshot"),
    { ASSETS: assets },
    context,
  );

  assert.equal(response.status, 404);
  assert.doesNotMatch(await response.text(), /127\.0\.0\.1|GAMEFACTORY_LOCAL_URL|CUSTOMER_HTTP/);
});
