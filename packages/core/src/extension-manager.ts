import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  CapabilityKind,
  Disposable,
  ExtensionDescriptor,
  ActiveExtension,
  ExtensionManifest,
  FactoryAPI,
  FactoryEvent,
  FactoryExtension,
  Logger
} from "./types.js";
import { CapabilityRegistry } from "./registry.js";

const MANIFEST_NAME = "factory.extension.json";

function validateManifest(value: unknown, path: string): ExtensionManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid extension manifest: ${path}`);
  const manifest = value as Record<string, unknown>;
  for (const field of ["name", "version", "apiVersion", "entry"] as const) {
    if (typeof manifest[field] !== "string") throw new Error(`Extension manifest ${path} is missing ${field}`);
  }
  if (!Array.isArray(manifest.activation) || !manifest.activation.every((entry) => typeof entry === "string")) {
    throw new Error(`Extension manifest ${path} has invalid activation list`);
  }
  if (!manifest.contributes || typeof manifest.contributes !== "object" || Array.isArray(manifest.contributes)) {
    throw new Error(`Extension manifest ${path} has invalid contributes map`);
  }
  return manifest as unknown as ExtensionManifest;
}

export async function discoverExtension(path: string): Promise<ExtensionDescriptor> {
  const info = await stat(path);
  const manifestPath = info.isDirectory() ? resolve(path, MANIFEST_NAME) : path;
  const root = dirname(manifestPath);
  const content = await readFile(manifestPath, "utf8");
  const manifest = validateManifest(JSON.parse(content) as unknown, manifestPath);
  const manifestSha256 = createHash("sha256").update(content).digest("hex");
  return { root, manifestPath, manifestSha256, manifest };
}

export class ExtensionManager {
  private readonly descriptors = new Map<string, ExtensionDescriptor>();
  private readonly capabilityProviders = new Map<string, string>();
  private readonly active = new Map<string, Disposable[]>();
  private readonly activatedAt = new Map<string, string>();
  private readonly activationCapabilities = new Map<string, Set<string>>();
  private readonly activating = new Map<string, Promise<void>>();
  private readonly handlers = new Set<(event: FactoryEvent) => Promise<void> | void>();
  private eventQueue: Promise<void> = Promise.resolve();

  constructor(readonly registry: CapabilityRegistry, private readonly logger: Logger) {}

  addDescriptor(descriptor: ExtensionDescriptor): void {
    if (this.descriptors.has(descriptor.manifest.name)) throw new Error(`Duplicate extension: ${descriptor.manifest.name}`);
    this.descriptors.set(descriptor.manifest.name, descriptor);
    for (const [kind, ids] of Object.entries(descriptor.manifest.contributes)) {
      for (const id of ids ?? []) {
        const key = `${kind}:${id}`;
        if (this.capabilityProviders.has(key)) throw new Error(`Multiple extensions provide ${key}`);
        this.capabilityProviders.set(key, descriptor.manifest.name);
      }
    }
  }

  listDescriptors(): ExtensionDescriptor[] {
    return [...this.descriptors.values()];
  }

  listActiveExtensions(): ActiveExtension[] {
    return [...this.active.keys()].flatMap((name): ActiveExtension[] => {
      const descriptor = this.descriptors.get(name);
      const activatedAt = this.activatedAt.get(name);
      if (!descriptor || !activatedAt) return [];
      return [{
        name,
        version: descriptor.manifest.version,
        activatedAt,
        capabilities: [...(this.activationCapabilities.get(name) ?? [])].sort(),
        activation: [...descriptor.manifest.activation],
        manifestSha256: descriptor.manifestSha256,
        permissions: [...(descriptor.manifest.permissions ?? [])],
        ...(descriptor.manifest.description ? { description: descriptor.manifest.description } : {})
      }];
    });
  }

  explain(capabilities: string[]): Array<{ capability: string; extension?: string; active: boolean }> {
    return capabilities.map((capability) => {
      const extension = this.capabilityProviders.get(capability);
      return extension
        ? { capability, extension, active: this.active.has(extension) }
        : { capability, active: false };
    });
  }

  async activateFor(capability: string): Promise<void> {
    await this.activateCapability(capability, []);
  }

  private async activateCapability(capability: string, lineage: string[]): Promise<void> {
    const extensionName = this.capabilityProviders.get(capability);
    if (!extensionName) throw new Error(`No extension provides ${capability}`);
    const capabilities = this.activationCapabilities.get(extensionName) ?? new Set<string>();
    capabilities.add(capability);
    this.activationCapabilities.set(extensionName, capabilities);
    try {
      await this.activateExtension(extensionName, lineage);
    } catch (error) {
      if (!this.active.has(extensionName)) this.activationCapabilities.delete(extensionName);
      throw error;
    }
  }

  async activateExtension(name: string, lineage: string[] = []): Promise<void> {
    if (this.active.has(name)) return;
    if (lineage.includes(name)) throw new Error(`Extension dependency cycle: ${[...lineage, name].join(" -> ")}`);
    const inFlight = this.activating.get(name);
    if (inFlight) return inFlight;

    const operation = this.performActivation(name, [...lineage, name]);
    this.activating.set(name, operation);
    try {
      await operation;
    } finally {
      this.activating.delete(name);
    }
  }

  private async performActivation(name: string, lineage: string[]): Promise<void> {
    const descriptor = this.descriptors.get(name);
    if (!descriptor) throw new Error(`Unknown extension: ${name}`);
    if (!descriptor.manifest.apiVersion.startsWith("1.")) throw new Error(`Unsupported extension API: ${descriptor.manifest.apiVersion}`);

    for (const required of descriptor.manifest.requires ?? []) await this.activateCapability(required, lineage);

    const disposables: Disposable[] = [];
    const api: FactoryAPI = {
      extensionName: name,
      get: <T>(kind: CapabilityKind, id: string) => this.registry.get<T>(kind, id),
      register: <T>(kind: CapabilityKind, id: string, value: T) => {
        const disposable = this.registry.register(kind, id, value, name);
        disposables.push(disposable);
        return disposable;
      },
      onEvent: (handler) => {
        this.handlers.add(handler);
        const disposable = { dispose: () => { this.handlers.delete(handler); } };
        disposables.push(disposable);
        return disposable;
      },
      log: this.logger
    };

    try {
      const entryUrl = pathToFileURL(resolve(descriptor.root, descriptor.manifest.entry)).href;
      const module = await import(entryUrl) as { default?: FactoryExtension | ((api: FactoryAPI) => unknown) };
      if (!module.default) throw new Error(`Extension ${name} has no default export`);
      const result = typeof module.default === "function"
        ? await module.default(api)
        : await module.default.activate(api);
      if (result && typeof result === "object" && "dispose" in result && !disposables.includes(result as Disposable)) disposables.push(result as Disposable);
      this.active.set(name, disposables);
      this.activatedAt.set(name, new Date().toISOString());
      await this.emit({ type: "extension:activate", extension: name, at: new Date().toISOString() });
    } catch (error) {
      this.active.delete(name);
      this.activatedAt.delete(name);
      for (const disposable of disposables.reverse()) await disposable.dispose();
      const message = error instanceof Error ? error.message : String(error);
      await this.emit({ type: "extension:error", extension: name, error: message, at: new Date().toISOString() });
      throw new Error(`Failed to activate extension ${name}: ${message}`);
    }
  }

  async emit(event: FactoryEvent): Promise<void> {
    const operation = this.eventQueue.then(() => this.dispatch(event));
    this.eventQueue = operation.catch(() => undefined);
    await operation;
  }

  private async dispatch(event: FactoryEvent): Promise<void> {
    for (const handler of [...this.handlers]) {
      try {
        await handler(event);
      } catch (error) {
        this.logger.warn("Extension event handler failed", { event: event.type, error: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const reporter of this.registry.getAll<{ id?: string; onEvent(event: FactoryEvent): Promise<void> | void }>("reporter")) {
      try {
        await reporter.onEvent(event);
      } catch (error) {
        this.logger.warn("Reporter failed", { reporter: reporter.id ?? "unknown", event: event.type, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(this.activating.values());
    await this.eventQueue;
    for (const disposables of [...this.active.values()].reverse()) {
      for (const disposable of disposables.reverse()) await disposable.dispose();
    }
    this.active.clear();
    this.activatedAt.clear();
    this.activationCapabilities.clear();
    this.handlers.clear();
  }
}
