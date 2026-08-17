/**
 * Smoke tests for dsh-context-steady against real DSH Session/surface
 * machinery and a mocked ctx (no keys, no model network).
 *
 * Covers the deterministic pipeline, fail-closed pruning semantics, the
 * optional LLM digest upgrade path that unlocks raw-surface pruning, packet
 * replacement bookkeeping, checkpoint rollup, and both model-facing tools.
 */
import assert from "node:assert/strict";
import { createAssistantMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { Context } from "@deepseek-ai/cordis";
import Storage from "@deepseek-ai/dsh-storage";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { apply, Config, inject, name } from "../lib/index.js";

let sessionCounter = 0;

function makeSession() {
  sessionCounter += 1;
  return Session.create(SessionId(`smoke-session-${sessionCounter}`));
}

function userText(text) {
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: "user" },
  });
}

function assistantText(text) {
  return createAssistantMessage({
    content: [{ type: "text", text }],
    source: { provider: "mock", model: "mock-1" },
  });
}

function appendAssistant(session, turn, step, text, usage = undefined) {
  session.append("assistant/message", {
    turn,
    step,
    message: assistantText(text),
    ...(usage === undefined ? {} : { usage }),
  }, { surfaceOp: "append" });
}

function openTurn(session, turn) {
  session.append("turn/start", { turn });
}

function appendTurnBodyOnly(session, turn, text) {
  session.append("user/message", userText(text), { surfaceOp: "append" });
  session.append("step/start", { turn, step: 1 });
  appendAssistant(session, turn, 1, "I will create a new file because the tests require it.");
  session.append("step/end", { turn, step: 1 });
}

function appendTurnEnd(session, turn) {
  session.append("turn/end", { turn, reason: { kind: "stop" } });
}

async function makeMemoryStorageDomain() {
  const units = new Map();
  const ctx = new Context();
  await ctx.plugin(Storage);
  ctx.storage.backend.register("memory", {
    kv: {
      async open(descriptor) {
        let stored = units.get(descriptor.name);
        if (!stored) {
          stored = {
            version: descriptor.version,
            tables: Object.fromEntries(descriptor.tables.map((name) => [name, {}])),
            global: null,
          };
          units.set(descriptor.name, stored);
        }
        assert.equal(stored.version, descriptor.version);
        return {
          async loadAll() {
            return structuredClone({ tables: stored.tables, global: stored.global });
          },
          async putRecord(table, key, value) {
            stored.tables[table][key] = structuredClone(value);
          },
          async deleteRecord(table, key) {
            delete stored.tables[table][key];
          },
          async setGlobal(value) {
            stored.global = structuredClone(value);
          },
          async close() {},
        };
      },
    },
    async close() {},
  });
  return { facility: new DomainFacility(ctx, { backend: "memory", routes: {} }), units };
}

function makeCtx(config, { llmJson, llmJsons, storageDomain } = {}) {
  const listeners = new Map();
  const tools = new Map();
  const llmCalls = [];
  const pending = [];
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    effect(execute) {
      const dispose = execute();
      return typeof dispose === "function" ? dispose : () => {};
    },
    inject(deps, callback) {
      const promise = storageDomain && deps.includes("storageDomain")
        ? Promise.resolve(callback({ storageDomain }))
        : Promise.resolve();
      pending.push(promise);
      return { then: promise.then.bind(promise), catch: promise.catch.bind(promise) };
    },
    on(event, callback) {
      const list = listeners.get(event) ?? [];
      list.push(callback);
      listeners.set(event, list);
      return () => {};
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => {};
      },
    },
    tokenMeter: {
      measure(session) {
        return {
          logRevision: session.events.length,
          baseline: { kind: "estimated", tokens: 500_000 },
          surfaceDeltaTokens: 0,
          totalTokens: 500_000,
          surfaceTokens: session.surface.nodes.length * 10,
          nodes: session.surface.nodes.map((seq) => ({ seq, tokens: 10 })),
        };
      },
      estimateMessage(message) {
        const text = (message.content ?? [])
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join(" ");
        return Math.ceil(text.length / 4) + 4;
      },
    },
    llm: {
      async *stream(options) {
        llmCalls.push(options);
        const text = llmJsons?.[llmCalls.length - 1] ?? llmJson;
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text };
        yield { type: "block-end", index: 0, block: { type: "text", text } };
        yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
        yield { type: "finish", reason: { kind: "stop" } };
      },
    },
  };
  apply(ctx, config);
  return {
    ctx,
    listeners,
    tools,
    llmCalls,
    storageReady: () => Promise.all(pending),
    preStep: async (agent, turn = 2) => {
      const list = listeners.get("agent/pre-step") ?? [];
      assert.equal(list.length, 1, "agent/pre-step listener registered");
      return list[0]({ agent, turn, step: 1, signal: new AbortController().signal }, async () => ({
        kind: "enter",
        messages: [userText(`prompt turn ${turn}`)],
      }));
    },
    turnStopping: async (agent, turn = 1) => {
      const list = listeners.get("agent/turn-stopping") ?? [];
      assert.equal(list.length, 1, "agent/turn-stopping listener registered");
      return list[0]({ agent, turn, signal: new AbortController().signal });
    },
  };
}

function packetEvents(session) {
  return session.events.filter(
    (event) => event.type === "user/message"
      && event.data.source?.kind === "plugin"
      && event.data.source.plugin === "dsh-context-steady",
  );
}

function agentFor(session, ctx) {
  return {
    id: session.id,
    session,
    ctx,
    options: { provider: "mock", model: "mock-1" },
  };
}

function status(harness, session) {
  const tool = harness.tools.get("context_steady_status");
  return tool.execute({}, {
    agent: agentFor(session, harness.ctx),
    signal: new AbortController().signal,
  });
}

// ── 1. Loader contract and schema defaults ───────────────────────────────────
assert.equal(name, "context-steady");
assert.deepEqual(inject, ["tools", "llm", "tokenMeter"]);
const resolved = Config({});
assert.equal(resolved.enabled, true);
assert.equal(resolved.activationThresholdTokens, 500000, "500K before the first digest");
assert.equal(resolved.digest.llm.enabled, false);
assert.equal(resolved.digest.everyTurns, 4);
assert.equal(resolved.digest.llm.maxTokens, 768);
assert.equal(resolved.checkpoint.everyTurns, 6);
assert.equal(resolved.packet.maxTokens, 3000);
const boundedHarness = makeCtx({
  digest: { everyTurns: 999, llm: { timeoutMs: 1, maxTranscriptChars: 1 } },
  packet: { recentDigests: 999, maxTokens: 999_999 },
  toolExpandMaxChars: 1,
});
const boundedSession = makeSession();
const boundedStatus = await status(boundedHarness, boundedSession);
assert.equal(boundedStatus.packetBudget, 180000, "direct apply clamps packet config to schema bounds");
console.log("ok: loader contract and schema defaults");

// ── 2. Deterministic digest + packet append, no unauthorized pruning ─────────
{
  const harness = makeCtx({ activationThresholdTokens: 0 });
  const session = makeSession();
  const agent = agentFor(session, harness.ctx);

  openTurn(session, 1);
  await harness.preStep(agent, 1);
  appendTurnBodyOnly(session, 1, "Please add a smoke test for the packet layer.");
  await harness.turnStopping(agent, 1);
  appendTurnEnd(session, 1);

  session.append("turn/start", { turn: 2 });
  await harness.preStep(agent, 2);

  const packets = packetEvents(session);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].surfaceOp, "append", "fallback digest must not authorize raw pruning");
  assert.equal(session.surface.nodes.includes(packets[0].seq), true);

  const report = await status(harness, session);
  assert.equal(report.activated, true);
  assert.equal(report.digests, 1);
  assert.equal(report.authoritativeDigests, 0);
  assert.equal(report.packetOnSurface, true);
  assert.equal(report.coveredSurfaceNodes, 0);
  console.log("ok: deterministic digest ledger and fail-closed append packet");

  // The expand tool re-reads the raw turn behind the digest ref.
  const expand = harness.tools.get("context_steady_expand");
  const raw = await expand.execute(
    { ref: "dshcs:digest:1", maxChars: 10_000 },
    { agent, signal: new AbortController().signal },
  );
  assert.match(raw, /smoke test for the packet layer/);
  console.log("ok: context_steady_expand re-reads the raw journal span");
}

// ── 3. Authoritative LLM digest unlocks surface pruning ──────────────────────
{
  const llmJson = JSON.stringify({
    userIntent: "Create a smoke test for surface pruning.",
    actionsTaken: ["write test"],
    decisions: ["Prune only authoritative spans"],
    filesTouched: [{ path: "/tmp/test.mjs", action: "created" }],
    factsLearned: ["pruning is surface-level"],
    openQuestions: [],
    risks: ["over-pruning"],
    nextSteps: ["run the test"],
    memoryCandidates: [],
  });
  const harness = makeCtx({
    activationThresholdTokens: 0,
    digest: { everyTurns: 1, llm: { enabled: true, provider: "mock", model: "mock-1" } },
  }, { llmJson });
  const session = makeSession();
  const agent = agentFor(session, harness.ctx);

  openTurn(session, 1);
  await harness.preStep(agent, 1);
  appendTurnBodyOnly(session, 1, "Add pruning smoke coverage.");
  const firstSurfaceSeq = session.surface.nodes[0];
  await harness.turnStopping(agent, 1);
  appendTurnEnd(session, 1);

  session.append("turn/start", { turn: 2 });
  await harness.preStep(agent, 2);

  assert.equal(harness.llmCalls.length, 1, "one side LLM digest call");
  const packets = packetEvents(session);
  assert.equal(packets.length, 1);
  assert.notEqual(packets[0].surfaceOp, "append", "authoritative digest must replace the covered raw span");
  const shadowed = new Set(packets[0].sourceEventSeqs ?? []);
  assert.equal(shadowed.has(firstSurfaceSeq), true, "raw user message is shadowed from the surface");
  assert.equal(session.surface.nodes.includes(firstSurfaceSeq), false, "raw span leaves the provider-bound surface");
  assert.equal(session.events.some((event) => event.seq === firstSurfaceSeq), true, "append-only log still keeps the raw span");

  const report = await status(harness, session);
  assert.equal(report.authoritativeDigests, 1);
  assert.equal(report.coveredSurfaceNodes >= 2, true);

  // Simulate a process restart: reconstruct a fresh Session from the durable
  // log and load a fresh plugin instance. Coverage and packet presence must
  // survive purely from the log (surfaceOp + sourceEventSeqs).
  session.append("turn/end", { turn: 2, reason: { kind: "stop" } });
  const replaySession = Session.create(SessionId(`smoke-replay-${sessionCounter}`), session.events);
  const replayHarness = makeCtx({ activationThresholdTokens: 0 });
  const replayReport = await status(replayHarness, replaySession);
  assert.equal(replayReport.packetOnSurface, true);
  assert.equal(replayReport.coveredSurfaceNodes >= 2, true);
  assert.equal(replaySession.surface.nodes.includes(firstSurfaceSeq), false);
  assert.equal(replaySession.events.some((event) => event.seq === firstSurfaceSeq), true);
  console.log("ok: packet coverage is reconstructed from the persisted log after restart");
}

// ── 4. LLM digests batch settled turns at the configured cadence ────────────
{
  const digestFor = (turn) => ({
    userIntent: `Persist turn ${turn}.`,
    actionsTaken: [`action ${turn}`],
    decisions: [`decision ${turn}`],
    filesTouched: [{ path: `/tmp/batch-${turn}.mjs`, action: "modified" }],
    factsLearned: [`fact ${turn}`],
    openQuestions: [],
    risks: [],
    nextSteps: [],
    memoryCandidates: [],
  });
  const harness = makeCtx({
    activationThresholdTokens: 0,
    digest: { everyTurns: 2, llm: { enabled: true, provider: "mock", model: "mock-1" } },
    checkpoint: { everyTurns: 2, maxTokens: 500 },
  }, { llmJson: `\u0060\u0060\u0060json\n${JSON.stringify([digestFor(1), digestFor(2)])}\n\u0060\u0060\u0060` });
  const session = makeSession();
  const agent = agentFor(session, harness.ctx);

  openTurn(session, 1);
  await harness.preStep(agent, 1);
  appendTurnBodyOnly(session, 1, "Batch turn one.");
  await harness.turnStopping(agent, 1);
  appendTurnEnd(session, 1);
  assert.equal(harness.llmCalls.length, 0, "first turn stays deterministic until cadence boundary");

  openTurn(session, 2);
  await harness.preStep(agent, 2);
  appendTurnBodyOnly(session, 2, "Batch turn two.");
  await harness.turnStopping(agent, 2);
  appendTurnEnd(session, 2);
  assert.equal(harness.llmCalls.length, 1, "two settled turns share one side request");
  const report = await status(harness, session);
  assert.equal(report.authoritativeDigests, 2);
  const packetText = packetEvents(session).at(-1).data.content[0].text;
  assert.match(packetText, /decision 1/, "checkpoint refreshes fallback content after LLM upgrade");
  console.log("ok: LLM digests batch at the configured cadence");
}

// ── 5. Subsequent packet replaces only the previous packet when fallback ────
{
  const harness = makeCtx({ activationThresholdTokens: 0 });
  const session = makeSession();
  const agent = agentFor(session, harness.ctx);

  openTurn(session, 1);
  await harness.preStep(agent, 1);
  appendTurnBodyOnly(session, 1, "First turn.");
  await harness.turnStopping(agent, 1);
  appendTurnEnd(session, 1);

  openTurn(session, 2);
  await harness.preStep(agent, 2);
  const firstPacket = packetEvents(session).at(-1);
  const secondTurnUserSeq = session.seq;

  appendTurnBodyOnly(session, 2, "Second turn, still deterministic.");
  await harness.turnStopping(agent, 2);
  appendTurnEnd(session, 2);

  openTurn(session, 3);
  await harness.preStep(agent, 3);

  const packets = packetEvents(session);
  assert.equal(packets.length, 2);
  assert.deepEqual(packets[1].surfaceOp, { op: "replace", start: firstPacket.seq, end: firstPacket.seq });
  assert.equal(session.surface.nodes.includes(firstPacket.seq), false, "old packet leaves the surface");
  assert.equal(session.surface.nodes.includes(secondTurnUserSeq), true, "fallback-covered raw turn stays verbatim");
  console.log("ok: packet-only replacement keeps fallback raw turns verbatim");
}

// ── 6. Checkpoint rollup and budgeted packet content ─────────────────────────
{
  const harness = makeCtx({
    activationThresholdTokens: 0,
    checkpoint: { everyTurns: 2, maxTokens: 500 },
    packet: { recentDigests: 1, maxTokens: 400 },
  });
  const session = makeSession();
  const agent = agentFor(session, harness.ctx);

  for (let turn = 1; turn <= 3; turn += 1) {
    if (turn === 1) {
      openTurn(session, turn);
      await harness.preStep(agent, turn);
      appendTurnBodyOnly(session, turn, `Turn ${turn}: build the checkpoint smoke case.`);
    } else {
      appendTurnBodyOnly(session, turn, `Turn ${turn}: build the checkpoint smoke case.`);
    }
    await harness.turnStopping(agent, turn);
    appendTurnEnd(session, turn);
    openTurn(session, turn + 1);
    await harness.preStep(agent, turn + 1);
  }

  const report = await status(harness, session);
  assert.equal(report.digests, 3);
  assert.equal(report.checkpointTurns >= 2, true, "two-turn checkpoint rolled up");
  const packets = packetEvents(session);
  const lastPacketText = packets.at(-1).data.content[0].text;
  assert.match(lastPacketText, /Stable checkpoint/);
  assert.match(lastPacketText, /Turn 3 \[ref: dshcs:digest:3\]/);
  console.log("ok: checkpoint rollup and packet layer ordering");
}

// ── 7. Authoritative LLM digest survives restart through storage sidecar ────
{
  const { facility } = await makeMemoryStorageDomain();
  const llmJson = JSON.stringify({
    userIntent: "Persist the authoritative digest.",
    actionsTaken: ["write sidecar"],
    decisions: ["Restore authoritative content after resume"],
    filesTouched: [{ path: "/tmp/sidecar.mjs", action: "modified" }],
    factsLearned: ["storage-domain keeps the digest durable"],
    openQuestions: [],
    risks: [],
    nextSteps: ["resume the session"],
    memoryCandidates: [],
  });
  const config = {
    activationThresholdTokens: 0,
    digest: { everyTurns: 1, llm: { enabled: true, provider: "mock", model: "mock-1" } },
  };
  const firstHarness = makeCtx(config, { llmJson, storageDomain: facility });
  await firstHarness.storageReady();
  const session = makeSession();
  const agent = agentFor(session, firstHarness.ctx);

  openTurn(session, 1);
  await firstHarness.preStep(agent, 1);
  appendTurnBodyOnly(session, 1, "Persist this digest before restart.");
  await firstHarness.turnStopping(agent, 1);
  appendTurnEnd(session, 1);

  const persistedReport = await status(firstHarness, session);
  assert.equal(persistedReport.sidecarAvailable, true);
  assert.equal(persistedReport.sidecarDigests, 1);
  await facility.get("dsh_context_steady")?.close();

  const replaySession = Session.create(session.id, session.events, session.header);
  const replayHarness = makeCtx({ activationThresholdTokens: 0 }, { storageDomain: facility });
  await replayHarness.storageReady();
  const replayReport = await status(replayHarness, replaySession);
  assert.equal(replayReport.sidecarLoaded, true);
  assert.equal(replayReport.sidecarDigests, 1);
  assert.equal(replayReport.authoritativeDigests, 1);
  console.log("ok: authoritative LLM digest survives restart through storage sidecar");
}

console.log("\nall dsh-context-steady smoke tests passed");
