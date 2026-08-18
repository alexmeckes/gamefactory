---
name: analyze-factory-run
description: Diagnose a completed or interrupted GameFactory run using traces, prompt manifests, artifacts, metrics, retries, usage, and project history. Use for workflow retrospectives, Observatory investigations, long runs, missing live events, repeated failures, or deciding whether to change the game, prompt, graph, evaluator, model routing, or infrastructure.
---

# Analyze Factory Run

Reconstruct what happened before proposing fixes. Treat trace gaps and missing provenance as findings, not permission to guess.

## Reconstruct the run

1. Identify project, phase, campaign, run, candidate, revision, and terminal state.
2. Build the chronological node and repair sequence from durable traces and journal events.
3. Associate every invocation with configured and provider-reported model, effort, skills, token usage, artifacts, outcome, and descendants.
4. Compare planned graph execution with what ran, skipped, retried, escalated, or remained incomplete.
5. Inspect accepted and rejected engine evidence rather than relying on summaries.

## Classify root causes

Assign each material problem to one primary class: product thesis or scope; gameplay implementation; visual direction or assets; prompt, role, handoff, or skill; graph ordering, repair, or concurrency; evaluator or metric validity; model routing; infrastructure; or missing evidence.

Do not recommend a prompt change for an engine failure, a larger model for a broken contract, or a tournament for an undefined product thesis.

## Recommend changes

For each root cause provide evidence, impact, proposed change, owner layer, verification test, expected benefit, and risk. Separate current-game changes from reusable factory improvements. Rank by leverage and confidence.

Return what worked, what failed, what remains unknown, and the smallest next experiment. Never describe synthetic scores as human evidence of fun.
