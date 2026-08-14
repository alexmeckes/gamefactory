import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

const CREDENTIAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface CredentialCipher {
  seal(value: string): Promise<string>;
  unseal(value: string): Promise<string>;
}

export interface CredentialResolution {
  value: string;
  source: "environment" | "local-store";
}

function credentialRoot(): string {
  if (process.env.GAMEFACTORY_CREDENTIAL_HOME) return resolve(process.env.GAMEFACTORY_CREDENTIAL_HOME);
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (!local) throw new Error("LOCALAPPDATA is required for the Windows credential store");
    return resolve(local, "GameFactory", "credentials");
  }
  if (process.platform === "darwin") return resolve(homedir(), "Library", "Application Support", "GameFactory", "credentials");
  return resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"), "gamefactory", "credentials");
}

function validateName(name: string): string {
  if (!CREDENTIAL_PATTERN.test(name)) throw new Error("Credential names may contain letters, numbers, dot, underscore, and dash, and must be at most 128 characters");
  return name;
}

function runPowerShell(script: string, input: string): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(`Windows credential protection failed: ${stderr.trim() || `exit ${String(code)}`}`));
      else resolveOutput(stdout.replace(/[\r\n]+$/, ""));
    });
    child.stdin.end(input, "utf8");
  });
}

export class WindowsDpapiCredentialCipher implements CredentialCipher {
  async seal(value: string): Promise<string> {
    if (process.platform !== "win32") throw new Error("Windows DPAPI credentials are available only on Windows");
    return runPowerShell("$v=[Console]::In.ReadToEnd(); ConvertTo-SecureString $v -AsPlainText -Force | ConvertFrom-SecureString", value);
  }

  async unseal(value: string): Promise<string> {
    if (process.platform !== "win32") throw new Error("Windows DPAPI credentials are available only on Windows");
    return runPowerShell("$v=[Console]::In.ReadToEnd(); $s=ConvertTo-SecureString $v; $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try {[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}", value);
  }
}

export class LocalCredentialStore {
  readonly root: string;

  constructor(options: { root?: string; cipher?: CredentialCipher } = {}) {
    this.root = resolve(options.root ?? credentialRoot());
    this.cipher = options.cipher ?? (process.platform === "win32" ? new WindowsDpapiCredentialCipher() : undefined);
  }

  private readonly cipher: CredentialCipher | undefined;

  private path(name: string): string {
    const validName = validateName(name);
    const digest = createHash("sha256").update(validName).digest("hex");
    return resolve(this.root, `${digest}.credential.json`);
  }

  async set(name: string, value: string): Promise<void> {
    validateName(name);
    if (!value) throw new Error("Credential values must not be empty");
    if (!this.cipher) throw new Error("No OS-backed credential cipher is available; use the provider's environment variable instead");
    const sealed = await this.cipher.seal(value);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = this.path(name);
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, name, protectedValue: sealed })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      await rename(temporary, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      await rm(target, { force: true });
      await rename(temporary, target);
    }
  }

  async get(name: string): Promise<string | undefined> {
    validateName(name);
    if (!this.cipher) return undefined;
    try {
      const record = JSON.parse(await readFile(this.path(name), "utf8")) as { version?: unknown; name?: unknown; protectedValue?: unknown };
      if (record.version !== 1 || record.name !== name || typeof record.protectedValue !== "string") throw new Error(`Credential record ${name} is invalid`);
      return await this.cipher.unseal(record.protectedValue);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async remove(name: string): Promise<boolean> {
    validateName(name);
    try {
      await rm(this.path(name));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async list(): Promise<string[]> {
    try {
      const names: string[] = [];
      for (const entry of await readdir(this.root)) {
        if (!entry.endsWith(".credential.json")) continue;
        try {
          const record = JSON.parse(await readFile(resolve(this.root, entry), "utf8")) as { name?: unknown };
          if (typeof record.name === "string" && CREDENTIAL_PATTERN.test(record.name)) names.push(record.name);
        } catch { /* ignore unrelated or corrupt files when listing */ }
      }
      return [...new Set(names)].sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

export async function resolveCredential(name: string, environmentName?: string, store = new LocalCredentialStore()): Promise<CredentialResolution | undefined> {
  if (environmentName) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(environmentName)) throw new Error("Credential environment names must be valid environment variable names");
    const value = process.env[environmentName];
    if (value) return { value, source: "environment" };
  }
  const value = await store.get(name);
  return value ? { value, source: "local-store" } : undefined;
}
