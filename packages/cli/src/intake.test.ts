import assert from "node:assert/strict";
import test from "node:test";
import type { IntakeQuestion } from "@gamefactory/core";
import { formatIntakeQuestion, parseIntakeChoice } from "./intake.js";

const question: IntakeQuestion = {
  id: "test",
  prompt: "Choose a direction?",
  whyItMatters: "It changes the prototype.",
  options: [
    { id: "known", label: "Known direction", description: "Keep the supplied direction." },
    { id: "figure-it-out", label: "Figure it out", description: "Delegate the decision.", delegates: true }
  ]
};

test("intake choices accept numbers, ids, and labels", () => {
  assert.equal(parseIntakeChoice("2", question)?.id, "figure-it-out");
  assert.equal(parseIntakeChoice("figure-it-out", question)?.delegates, true);
  assert.equal(parseIntakeChoice("Figure it out", question)?.delegates, true);
  assert.equal(parseIntakeChoice("9", question), undefined);
});

test("formatted intake makes delegation visible", () => {
  const formatted = formatIntakeQuestion(question);
  assert.match(formatted, /Why it matters/);
  assert.match(formatted, /2\. Figure it out/);
});
