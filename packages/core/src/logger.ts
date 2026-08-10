import type { Logger } from "./types.js";

export class ConsoleLogger implements Logger {
  constructor(private readonly verbose = false) {}

  debug(message: string, details?: Record<string, unknown>): void {
    if (this.verbose) this.write("debug", message, details);
  }

  info(message: string, details?: Record<string, unknown>): void {
    this.write("info", message, details);
  }

  warn(message: string, details?: Record<string, unknown>): void {
    this.write("warn", message, details);
  }

  error(message: string, details?: Record<string, unknown>): void {
    this.write("error", message, details);
  }

  private write(level: string, message: string, details?: Record<string, unknown>): void {
    const suffix = details && Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : "";
    const line = `[${level}] ${message}${suffix}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }
}

export class MemoryLogger implements Logger {
  readonly entries: Array<{ level: string; message: string; details?: Record<string, unknown> }> = [];

  debug(message: string, details?: Record<string, unknown>): void { this.push("debug", message, details); }
  info(message: string, details?: Record<string, unknown>): void { this.push("info", message, details); }
  warn(message: string, details?: Record<string, unknown>): void { this.push("warn", message, details); }
  error(message: string, details?: Record<string, unknown>): void { this.push("error", message, details); }

  private push(level: string, message: string, details?: Record<string, unknown>): void {
    this.entries.push(details ? { level, message, details } : { level, message });
  }
}
