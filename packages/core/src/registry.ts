import type { CapabilityKind, Disposable } from "./types.js";

interface Entry<T = unknown> {
  extensionName: string;
  value: T;
}

export class CapabilityRegistry {
  private readonly entries = new Map<CapabilityKind, Map<string, Entry>>();

  register<T>(kind: CapabilityKind, id: string, value: T, extensionName: string): Disposable {
    let group = this.entries.get(kind);
    if (!group) {
      group = new Map();
      this.entries.set(kind, group);
    }
    if (group.has(id)) throw new Error(`Capability already registered: ${kind}:${id}`);
    group.set(id, { extensionName, value });
    return { dispose: () => { group?.delete(id); } };
  }

  get<T>(kind: CapabilityKind, id: string): T {
    const entry = this.entries.get(kind)?.get(id);
    if (!entry) throw new Error(`Capability not active: ${kind}:${id}`);
    return entry.value as T;
  }

  getAll<T>(kind: CapabilityKind): T[] {
    return [...(this.entries.get(kind)?.values() ?? [])].map((entry) => entry.value as T);
  }

  list(): Array<{ kind: CapabilityKind; id: string; extensionName: string }> {
    const output: Array<{ kind: CapabilityKind; id: string; extensionName: string }> = [];
    for (const [kind, group] of this.entries) {
      for (const [id, entry] of group) output.push({ kind, id, extensionName: entry.extensionName });
    }
    return output.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  }
}
