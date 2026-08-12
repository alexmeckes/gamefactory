import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  reconstructWorkflowState,
  WorkflowJournal,
  WorkflowJournalFormatError,
  type WorkflowJournalAppend,
  type WorkflowJournalEntry
} from "./journal.js";

function operation(index: number, overrides: Partial<WorkflowJournalAppend> = {}): WorkflowJournalAppend {
  return {
    runId: "run-1",
    campaignId: "campaign-1",
    experimentId: `experiment-${index}`,
    phase: "reserved",
    idempotencyKey: `operation-${index}`,
    fingerprints: { config: "config-sha", base: "base-sha" },
    data: { index },
    ...overrides
  };
}

test("journal serializes concurrent appends across instances and reads wait for them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamefactory-journal-concurrent-"));
  try {
    const path = join(directory, "journal.jsonl");
    const first = new WorkflowJournal(path);
    const second = new WorkflowJournal(resolve(directory, ".", "journal.jsonl"));
    const appends = Array.from({ length: 30 }, (_, index) => (index % 2 === 0 ? first : second).append(operation(index)));
    const readWhilePending = first.read();
    const [entries] = await Promise.all([readWhilePending, ...appends]);
    assert.equal(entries.length, 30);
    assert.deepEqual(entries.map((entry) => entry.sequence), Array.from({ length: 30 }, (_, index) => index + 1));
    assert.equal((await readFile(path, "utf8")).split("\n").filter(Boolean).length, 30);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("journal makes matching idempotency retries no-ops and rejects conflicting reuse", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamefactory-journal-idempotent-"));
  try {
    const path = join(directory, "journal.jsonl");
    const first = new WorkflowJournal(path);
    const second = new WorkflowJournal(path);
    const input = operation(1);
    const [left, right] = await Promise.all([first.append(input), second.append(input)]);
    assert.deepEqual(left, right);
    assert.equal((await first.read()).length, 1);
    await assert.rejects(
      second.append({ ...input, phase: "candidate-created" }),
      /idempotency key already belongs to another operation/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("journal ignores only a truncated final JSON line", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamefactory-journal-tail-"));
  try {
    const path = join(directory, "journal.jsonl");
    const journal = new WorkflowJournal(path);
    const entry = await journal.append(operation(1));
    await writeFile(path, `${JSON.stringify(entry)}\n{\"version\":1,\"sequence\":2`, "utf8");
    assert.deepEqual(await journal.read(), [entry]);
    const recovered = await journal.append(operation(2));
    assert.equal(recovered.sequence, 2);
    assert.deepEqual(await journal.read(), [entry, recovered]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("journal separates a complete final entry that is missing its newline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamefactory-journal-newline-"));
  try {
    const path = join(directory, "journal.jsonl");
    const journal = new WorkflowJournal(path);
    const first = await journal.append(operation(1));
    await writeFile(path, JSON.stringify(first), "utf8");
    const second = await journal.append(operation(2));
    assert.deepEqual(await journal.read(), [first, second]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("journal rejects malformed middle lines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamefactory-journal-malformed-"));
  try {
    const path = join(directory, "journal.jsonl");
    const journal = new WorkflowJournal(path);
    const first = await journal.append(operation(1));
    const third: WorkflowJournalEntry = {
      ...first,
      sequence: 2,
      experimentId: "experiment-2",
      idempotencyKey: "operation-2"
    };
    await writeFile(path, `${JSON.stringify(first)}\nnot-json\n${JSON.stringify(third)}\n`, "utf8");
    await assert.rejects(journal.read(), (error: unknown) => {
      assert.ok(error instanceof WorkflowJournalFormatError);
      assert.equal(error.line, 2);
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovery reconstructs latest state and exposes incomplete experiments", () => {
  const base = {
    version: 1 as const,
    runId: "run-1",
    campaignId: "campaign-1",
    timestamp: new Date(0).toISOString(),
    fingerprints: { config: "config-sha", base: "base-sha" }
  };
  const entries: WorkflowJournalEntry[] = [
    { ...base, sequence: 1, experimentId: "complete", phase: "reserved", idempotencyKey: "complete-reserved" },
    { ...base, sequence: 2, experimentId: "incomplete", phase: "reserved", idempotencyKey: "incomplete-reserved" },
    { ...base, sequence: 3, experimentId: "complete", phase: "recorded", idempotencyKey: "complete-recorded" },
    { ...base, sequence: 4, experimentId: "incomplete", phase: "evaluated", idempotencyKey: "incomplete-evaluated" },
    { ...base, sequence: 5, experimentId: "complete", phase: "cleaned", idempotencyKey: "complete-cleaned" }
  ];
  const state = reconstructWorkflowState(entries);
  assert.equal(state.lastSequence, 5);
  assert.equal(state.experiments.length, 2);
  assert.equal(state.experiments.find((item) => item.experimentId === "complete")?.latestPhase, "cleaned");
  assert.deepEqual(state.incomplete.map((item) => [item.experimentId, item.latestPhase]), [["incomplete", "evaluated"]]);
});
