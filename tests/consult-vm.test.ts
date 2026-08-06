import { describe, expect, test } from "bun:test";
import { runWorkflow, hashConsult } from "../src/workflow.js";
import { WorkflowErrorCode } from "../src/errors.js";

const consultScript = `
export const meta = { name: "c", description: "consult vm" };
phase("P1");
await agent("first", { label: "a1" });
const outcome = consult("should we continue?", { to: "agent" });
return outcome.summary;
`;

/**
 * Live-run the consult script once and capture the agent (callIndex 0) journal
 * entry from onAgentJournal — consult's own hash cannot be captured that way
 * (live consult throws before journaling), so it is computed via hashConsult.
 */
async function captureAgentEntry(): Promise<{ index: number; runId?: string; hash: string }> {
  let captured: { index: number; runId?: string; hash: string } | null = null;
  await runWorkflow(consultScript, {
    runId: "r1",
    agent: { run: async () => "done" },
    onAgentJournal: (entry) => {
      if (entry.index === 0) captured = { index: entry.index, runId: entry.runId, hash: entry.hash };
    },
  }).catch(() => {});
  if (!captured) throw new Error("agent (callIndex 0) journal entry was not captured");
  return captured;
}

const consultHash = hashConsult("should we continue?", { to: "agent" });

describe("consult VM contract", () => {
  test("live execution throws CONSULT_PENDING and interrupts the script", async () => {
    const calls: string[] = [];
    const outcome = await runWorkflow(consultScript, {
      runId: "r1",
      agent: {
        run: async (prompt: string) => {
          calls.push(prompt);
          return "done";
        },
      },
    }).catch((e) => e);
    expect(calls).toEqual(["first"]);
    expect(outcome.code).toBe(WorkflowErrorCode.CONSULT_PENDING);
    expect(outcome.payload).toMatchObject({
      prompt: "should we continue?",
      callIndex: 1,
      journalPrefix: "r1:",
      opts: { to: "agent" },
    });
  });

  test("replay returns the journaled outcome (live throws, replay returns)", async () => {
    const entry = await captureAgentEntry();
    const replay = await runWorkflow(consultScript, {
      runId: "r1",
      resumeJournal: new Map([
        ["r1:0", { index: entry.index, runId: entry.runId, hash: entry.hash, result: "done" }],
        ["r1:1", { index: 1, runId: "r1", hash: consultHash, result: { applied: true, summary: "ok" } }],
      ]),
      agent: { run: async () => "done" },
    });
    // The script consumes the replayed outcome (outcome.summary) — a replay
    // that returns undefined or the wrong object would fail this assertion.
    expect(replay.result).toBe("ok");
  });

  test("a settled:false entry is treated as a miss and rethrows CONSULT_PENDING", async () => {
    const entry = await captureAgentEntry();
    const calls: string[] = [];
    const outcome = await runWorkflow(consultScript, {
      runId: "r1",
      resumeJournal: new Map([
        ["r1:0", { index: entry.index, runId: entry.runId, hash: entry.hash, result: "done" }],
        [
          "r1:1",
          { index: 1, runId: "r1", hash: consultHash, result: { applied: false, reason: "x", settled: false } },
        ],
      ]),
      agent: {
        run: async (prompt: string) => {
          calls.push(prompt);
          return "done";
        },
      },
    }).catch((e) => e);
    // index 0 replayed (nothing ran live); the settled:false consult re-pended.
    expect(calls).toEqual([]);
    expect(outcome.code).toBe(WorkflowErrorCode.CONSULT_PENDING);
  });

  test("a hash-mismatched entry is a miss and rethrows CONSULT_PENDING", async () => {
    const entry = await captureAgentEntry();
    const calls: string[] = [];
    const outcome = await runWorkflow(consultScript, {
      runId: "r1",
      resumeJournal: new Map([
        ["r1:0", { index: entry.index, runId: entry.runId, hash: entry.hash, result: "done" }],
        ["r1:1", { index: 1, runId: "r1", hash: "bogus-hash", result: { applied: true, summary: "ok" } }],
      ]),
      agent: {
        run: async (prompt: string) => {
          calls.push(prompt);
          return "done";
        },
      },
    }).catch((e) => e);
    // index 0 replayed (hash matches); index 1 hash mismatch → the replayed
    // outcome is NOT returned — the consult re-pends instead.
    expect(calls).toEqual([]);
    expect(outcome.code).toBe(WorkflowErrorCode.CONSULT_PENDING);
  });

  test("a missing index-0 entry forces firstMiss=0 so replay always misses", async () => {
    const calls: string[] = [];
    const outcome = await runWorkflow(consultScript, {
      runId: "r1",
      resumeJournal: new Map([
        ["r1:1", { index: 1, runId: "r1", hash: consultHash, result: { applied: true, summary: "ok" } }],
      ]),
      agent: {
        run: async (prompt: string) => {
          calls.push(prompt);
          return "done";
        },
      },
    }).catch((e) => e);
    // index 0 has no entry → firstMiss becomes 0 → index 1's matching entry is
    // still a miss (callIndex 1 < firstMiss 0 is false) → consult re-pends
    // even though its own entry is present and hash-matches.
    expect(calls).toEqual(["first"]);
    expect(outcome.code).toBe(WorkflowErrorCode.CONSULT_PENDING);
  });

  test("settled:false re-pend consumes exactly one agent slot (maxAgents=3)", async () => {
    const entry = await captureAgentEntry();
    const slotScript = `
export const meta = { name: "c", description: "consult vm" };
phase("P1");
await agent("first", { label: "a1" });
let pending = null;
try {
  consult("should we continue?", { to: "agent" });
} catch (e) {
  pending = e.code;
}
await agent("second", { label: "a2" });
return pending;
`;
    const run = await runWorkflow(slotScript, {
      runId: "r1",
      maxAgents: 3,
      resumeJournal: new Map([
        ["r1:0", { index: entry.index, runId: entry.runId, hash: entry.hash, result: "done" }],
        [
          "r1:1",
          { index: 1, runId: "r1", hash: consultHash, result: { applied: false, reason: "x", settled: false } },
        ],
      ]),
      agent: { run: async () => "done" },
    });
    // 3 slots total: index-0 replay + settled:false consult (1 slot) + index-2
    // agent. The double-increment bug consumes 2 slots at the consult, so the
    // following agent() throws AGENT_LIMIT_EXCEEDED instead of completing.
    expect(run.result).toBe(WorkflowErrorCode.CONSULT_PENDING);
    expect(run.agentCount).toBe(3);
  });
});
