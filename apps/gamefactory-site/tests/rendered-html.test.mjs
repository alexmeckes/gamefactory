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
  assert.match(html, /Who did what, when, and why/);
  assert.match(html, /Portable replay/);
  assert.match(html, /Pulse Runner/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/);
});

test("proxies a private GameFactory snapshot through the narrow binding", async () => {
  const app = await worker();
  const expected = { version: 2, runId: "private-run", sequence: 7 };
  const response = await app.fetch(
    new Request("http://localhost/api/factory/snapshot"),
    {
      ASSETS: assets,
      CUSTOMER_HTTP_GAMEFACTORY: {
        fetch: async (request) => {
          assert.equal(new URL(request.url).pathname, "/api/snapshot");
          return Response.json(expected);
        },
      },
    },
    context,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("reports an offline bridge without leaking configuration", async () => {
  const app = await worker();
  const response = await app.fetch(
    new Request("http://localhost/api/factory/snapshot"),
    { ASSETS: assets },
    context,
  );

  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.connected, false);
  assert.doesNotMatch(JSON.stringify(body), /127\.0\.0\.1|GAMEFACTORY_LOCAL_URL|CUSTOMER_HTTP/);
});
