/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  CUSTOMER_HTTP_GAMEFACTORY?: Fetcher;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

function offlineBridge(): Response {
  return Response.json(
    {
      connected: false,
      error: "The local GameFactory bridge is offline or has not been bound to this Site.",
    },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

async function fetchFactory(env: Env, path: string, accept: string): Promise<Response> {
  if (env.CUSTOMER_HTTP_GAMEFACTORY) {
    return env.CUSTOMER_HTTP_GAMEFACTORY.fetch(
      new Request(`https://gamefactory.local${path}`, { headers: { accept } }),
    );
  }

  const localUrl = process.env.GAMEFACTORY_LOCAL_URL;
  if (localUrl && process.env.NODE_ENV !== "production") {
    return fetch(new URL(path, localUrl), {
      cache: "no-store",
      headers: { accept },
    });
  }

  return offlineBridge();
}

async function proxyFactory(request: Request, env: Env): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/factory/")) return undefined;
  if (request.method !== "GET") return Response.json({ error: "Method not allowed" }, { status: 405 });

  let path: string;
  let accept = "application/json";
  if (url.pathname === "/api/factory/snapshot") {
    path = `/api/snapshot${url.search}`;
  } else if (url.pathname === "/api/factory/stream") {
    path = `/api/stream${url.search}`;
    accept = "text/event-stream";
  } else {
    const match = /^\/api\/factory\/artifacts\/([a-f0-9]{64})$/i.exec(url.pathname);
    if (!match) return Response.json({ error: "Not found" }, { status: 404 });
    path = `/artifacts/${match[1]}`;
    accept = "application/octet-stream";
  }

  const upstream = await fetchFactory(env, path, accept);
  const headers = new Headers();
  for (const name of ["content-type", "content-length", "content-disposition"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("cache-control", accept === "text/event-stream" ? "no-cache, no-transform" : "no-store");
  if (accept === "text/event-stream") headers.set("connection", "keep-alive");
  return new Response(upstream.body, { status: upstream.status, headers });
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const factoryResponse = await proxyFactory(request, env);
    if (factoryResponse) return factoryResponse;

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
