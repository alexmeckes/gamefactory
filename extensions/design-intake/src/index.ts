import type { IntakeAnswer, IntakeDriver, IntakeOption, IntakeQuestion } from "@gamefactory/core";
import { defineExtension } from "@gamefactory/extension-sdk";

export const FIGURE_IT_OUT_OPTION_ID = "figure-it-out";

function option(id: string, label: string, description: string): IntakeOption {
  return { id, label, description };
}

function delegate(): IntakeOption {
  return {
    id: FIGURE_IT_OUT_OPTION_ID,
    label: "Figure it out",
    description: "Delegate this decision to the design agents. They must explore alternatives and preserve their reasoning.",
    delegates: true
  };
}

export const GAME_DESIGN_QUESTIONS: IntakeQuestion[] = [
  {
    id: "experience-priority",
    prompt: "Which part of the player experience should lead the first prototypes?",
    whyItMatters: "This sets the experiential compass without prescribing a mechanic.",
    options: [
      option("described-fantasy", "My description as written", "Keep the fantasy and emotional emphasis already present in the idea."),
      option("mastery", "Mastery and challenge", "Prioritize learning, execution, and visible improvement."),
      option("tension", "Tension and risk", "Prioritize pressure, consequential choices, and relief."),
      option("discovery", "Discovery and wonder", "Prioritize curiosity, surprise, and revealing a world or system."),
      option("expression", "Expression and connection", "Prioritize creativity, identity, cooperation, or social play."),
      delegate()
    ]
  },
  {
    id: "activity-certainty",
    prompt: "How settled is the activity players will perform most often?",
    whyItMatters: "This controls whether agents refine a known loop or compare fundamentally different loop families.",
    options: [
      option("preserve-described", "Preserve the described activity", "Treat the central activity in the idea as fixed and explore around it."),
      option("action", "Explore action and movement", "Bias prototypes toward timing, control, aiming, traversal, or physical execution."),
      option("strategy", "Explore strategy and problem-solving", "Bias prototypes toward planning, tradeoffs, puzzles, or systemic decisions."),
      option("creation", "Explore discovery and creation", "Bias prototypes toward exploration, building, simulation, or expressive play."),
      option("contrast", "Compare different loop families", "Intentionally prototype contrasting kinds of player activity."),
      delegate()
    ]
  },
  {
    id: "play-shape",
    prompt: "What play shape should the first playable target?",
    whyItMatters: "Session and social structure materially affect architecture, controls, and useful playtests.",
    options: [
      option("short-solo", "Short solo sessions", "A compact loop measured in minutes with fast entry and replay."),
      option("long-solo", "Longer solo sessions", "A sustained experience with room for progression, narrative, or deep systems."),
      option("local-social", "Local social play", "Players share a room, device, screen, or immediate conversation."),
      option("online-multiplayer", "Online multiplayer", "Networked cooperation, competition, or shared-world interaction is foundational."),
      option("persistent", "Persistent or open-ended play", "The game emphasizes long-term creation, simulation, collection, or return play."),
      delegate()
    ]
  },
  {
    id: "creative-freedom",
    prompt: "How much of the idea may the agents reinvent?",
    whyItMatters: "This establishes the boundary between authorship you want to retain and territory agents genuinely own.",
    options: [
      option("premise-only", "Keep only the premise", "The high concept is sacred; mechanics, structure, and presentation may change."),
      option("signature-mechanic", "Keep the signature mechanic", "Preserve the defining interaction and explore the surrounding game."),
      option("experience-and-style", "Keep the feeling and style", "Preserve experiential and aesthetic identity while mechanics remain open."),
      option("conservative", "Stay close to my description", "Interpret unspecified areas conservatively and minimize conceptual drift."),
      option("broad", "Explore broadly", "Allow radical alternatives as long as they remain legible responses to the idea."),
      delegate()
    ]
  },
  {
    id: "first-learning-goal",
    prompt: "What should the first prototypes teach us?",
    whyItMatters: "A prototype should answer a design question rather than act like a miniature production build.",
    options: [
      option("feel", "Whether the controls feel good", "Test input, movement, responsiveness, feedback, and moment-to-moment feel."),
      option("loop", "Whether the core loop holds attention", "Test repetition, pacing, motivation, and the desire to play again."),
      option("decisions", "Whether decisions are meaningful", "Test tradeoffs, strategy diversity, risk, and dominant solutions."),
      option("social", "Whether the social interaction works", "Test cooperation, competition, communication, or emergent group behavior."),
      option("identity", "Whether the game has a distinct identity", "Test the combined audiovisual, thematic, and interaction concept."),
      delegate()
    ]
  }
];

function selectedGuidance(answer: IntakeAnswer | undefined): string {
  return answer?.delegated ? "Agent-owned: explore alternatives and record the hypothesis." : answer?.label ?? "Unspecified";
}

export class GameDesignIntake implements IntakeDriver {
  readonly id = "game.design";

  async run(request: Parameters<IntakeDriver["run"]>[0]): Promise<Awaited<ReturnType<IntakeDriver["run"]>>> {
    if (request.brief.trim().length === 0) throw new Error("A game idea is required");
    const answers: IntakeAnswer[] = [];
    for (const question of GAME_DESIGN_QUESTIONS) {
      if (request.signal.aborted) throw request.signal.reason ?? new Error("Intake cancelled");
      const selected = await request.ask(question);
      if (!question.options.some((candidate) => candidate.id === selected.id)) throw new Error(`Intake returned an invalid option for ${question.id}`);
      answers.push({ questionId: question.id, optionId: selected.id, label: selected.label, delegated: selected.delegates === true });
    }
    const byQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));
    const delegatedDecisions = answers.filter((answer) => answer.delegated).map((answer) => answer.questionId);
    return {
      apiVersion: "gamefactory.game-brief/v1",
      provider: this.id,
      summary: delegatedDecisions.length > 0
        ? `Captured five intake decisions; delegated ${delegatedDecisions.length} to design agents.`
        : "Captured five explicit intake decisions.",
      answers,
      document: {
        apiVersion: "gamefactory.game-brief/v1",
        idea: request.brief.trim(),
        guidance: {
          experiencePriority: selectedGuidance(byQuestion.get("experience-priority")),
          activityCertainty: selectedGuidance(byQuestion.get("activity-certainty")),
          playShape: selectedGuidance(byQuestion.get("play-shape")),
          creativeFreedom: selectedGuidance(byQuestion.get("creative-freedom")),
          firstLearningGoal: selectedGuidance(byQuestion.get("first-learning-goal"))
        },
        delegatedDecisions,
        answers,
        nextStep: "Generate a draft design intent and contrasting prototype hypotheses. Delegated decisions remain open until supported by prototype evidence.",
        metadata: { provider: this.id, generatedAt: new Date().toISOString() }
      }
    };
  }
}

export default defineExtension((api) => api.register("intake", "game.design", new GameDesignIntake()));
