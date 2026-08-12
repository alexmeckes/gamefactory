import type { Writable } from "node:stream";
import type { Interface } from "node:readline/promises";
import type { IntakeOption, IntakeQuestion } from "@gamefactory/core";

export function parseIntakeChoice(value: string, question: IntakeQuestion): IntakeOption | undefined {
  const normalized = value.trim().toLowerCase();
  const numeric = Number(normalized);
  if (Number.isSafeInteger(numeric) && numeric >= 1 && numeric <= question.options.length) return question.options[numeric - 1];
  return question.options.find((option) => option.id.toLowerCase() === normalized || option.label.toLowerCase() === normalized);
}

export function formatIntakeQuestion(question: IntakeQuestion): string {
  const options = question.options.map((option, index) => `  ${index + 1}. ${option.label} — ${option.description}`).join("\n");
  return `\n${question.prompt}\nWhy it matters: ${question.whyItMatters}\n\n${options}\n`;
}

export async function chooseIntakeOption(question: IntakeQuestion, readline: Interface, output: Writable, signal: AbortSignal): Promise<IntakeOption> {
  output.write(formatIntakeQuestion(question));
  while (true) {
    const answer = await readline.question(`Choose 1-${question.options.length}: `, { signal });
    const selected = parseIntakeChoice(answer, question);
    if (selected) {
      output.write(selected.delegates ? "Delegated to the design agents.\n" : `Selected: ${selected.label}\n`);
      return selected;
    }
    output.write(`Enter a number from 1 to ${question.options.length}.\n`);
  }
}
