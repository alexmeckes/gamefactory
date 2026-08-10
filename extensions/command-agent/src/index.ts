import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentDriver, AgentResult } from "@gamefactory/core";
import { defineExtension } from "@gamefactory/extension-sdk";

function commandFor(request: Parameters<AgentDriver["run"]>[0]): string[] {
  const configured = request.campaign.parameters?.agentCommand;
  if (!Array.isArray(configured) || configured.length === 0 || !configured.every((item) => typeof item === "string")) {
    throw new Error("parameters.agentCommand must be a non-empty string array");
  }
  const replacements: Record<string, string> = {
    "{candidate}": request.candidate.root,
    "{experiment}": request.experimentId,
    "{objective}": request.campaign.objective
  };
  return configured.map((part) => Object.entries(replacements).reduce((value, [token, replacement]) => value.replaceAll(token, replacement), part));
}

export class CommandAgent implements AgentDriver {
  readonly id = "command.agent";

  async run(request: Parameters<AgentDriver["run"]>[0]): Promise<AgentResult> {
    const [executable, ...args] = commandFor(request);
    if (!executable) throw new Error("Agent command has no executable");
    const prompt = {
      objective: request.campaign.objective,
      experimentId: request.experimentId,
      candidateRoot: request.candidate.root,
      mutablePaths: request.campaign.mutablePaths ?? [],
      immutablePaths: request.campaign.immutablePaths ?? [],
      history: request.history.map((item) => ({ id: item.experimentId, status: item.status, summary: item.summary, metrics: item.metrics }))
    };
    const outputDirectory = resolve(request.candidate.root, ".factory", "agent", request.experimentId);
    await mkdir(outputDirectory, { recursive: true });
    const requestPath = resolve(outputDirectory, "request.json");
    const stdoutPath = resolve(outputDirectory, "stdout.log");
    const stderrPath = resolve(outputDirectory, "stderr.log");
    await writeFile(requestPath, `${JSON.stringify(prompt, null, 2)}\n`, "utf8");

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn(executable, args, {
        cwd: request.candidate.root,
        signal: request.signal,
        windowsHide: true,
        env: { ...process.env, GAMEFACTORY_REQUEST: requestPath, GAMEFACTORY_CANDIDATE: request.candidate.root }
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => resolveResult({ code, stdout, stderr }));
    });
    await Promise.all([writeFile(stdoutPath, result.stdout, "utf8"), writeFile(stderrPath, result.stderr, "utf8")]);
    if (result.code !== 0) throw new Error(`Agent command exited ${result.code}: ${result.stderr.slice(-1000)}`);
    return {
      summary: result.stdout.trim().split(/\r?\n/).at(-1) || `Agent command completed experiment ${request.experimentId}.`,
      artifacts: [
        { kind: "log", path: stdoutPath, mediaType: "text/plain", label: "Agent stdout" },
        { kind: "log", path: stderrPath, mediaType: "text/plain", label: "Agent stderr" },
        { kind: "other", path: requestPath, mediaType: "application/json", label: "Agent request" }
      ]
    };
  }
}

export default defineExtension((api) => api.register("agent", "command.agent", new CommandAgent()));
