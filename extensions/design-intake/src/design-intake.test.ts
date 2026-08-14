import assert from "node:assert/strict";
import test from "node:test";
import type { IntakeQuestion } from "@gamefactory/core";
import { FIGURE_IT_OUT_OPTION_ID, GAME_DESIGN_QUESTIONS, GameDesignIntake } from "./index.js";

test("every game-design intake question offers explicit delegation", () => {
  assert.equal(GAME_DESIGN_QUESTIONS.length, 5);
  for (const question of GAME_DESIGN_QUESTIONS) {
    const delegated = question.options.find((option) => option.id === FIGURE_IT_OUT_OPTION_ID);
    assert.equal(delegated?.label, "Figure it out");
    assert.equal(delegated?.delegates, true);
  }
});

test("figure-it-out answers remain open decisions for downstream design agents", async () => {
  const asked: IntakeQuestion[] = [];
  const result = await new GameDesignIntake().run({
    brief: "A strange game about navigating a living library",
    projectRoot: process.cwd(),
    signal: new AbortController().signal,
    async ask(question) {
      asked.push(question);
      return question.options.find((option) => option.id === FIGURE_IT_OUT_OPTION_ID)!;
    }
  });
  assert.equal(asked.length, 5);
  assert.equal(result.answers.every((answer) => answer.delegated), true);
  assert.deepEqual((result.document.delegatedDecisions as string[]), GAME_DESIGN_QUESTIONS.map((question) => question.id));
  assert.match(String((result.document.guidance as Record<string, unknown>).creativeFreedom), /Agent-owned/);
});

test("explicit selections are preserved without inventing extra decisions", async () => {
  const result = await new GameDesignIntake().run({
    brief: "A compact cooperative movement game",
    projectRoot: process.cwd(),
    signal: new AbortController().signal,
    async ask(question) { return question.options[0]!; }
  });
  assert.equal(result.answers.some((answer) => answer.delegated), false);
  assert.deepEqual(result.document.delegatedDecisions, []);
  assert.equal((result.document.guidance as Record<string, unknown>).playShape, "Short solo sessions");
});
