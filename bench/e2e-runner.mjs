/**
 * One-shot / resume runner for the dsh-context-steady E2E profile.
 *
 * Mirrors @deepseek-ai/dsh-headless, with one addition: when the
 * `resumeSessionId` config is non-empty it resumes the persisted session
 * through `ctx.agents.resume` instead of creating a fresh session, so the
 * second process run continues the same durable log.
 */

import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

export const name = "context-steady-e2e-runner";

/** Wait for both the task provider and the runner's core services. */
export const inject = ["headlessStartup", "agentDefaultModel", "agents", "sessions"];

export const Config = z.object({
  task: z.string().required(),
  resumeSessionId: z.string().default(""),
});

function summarize(events, firstSeq) {
  let started = false;
  let text = "";
  let reason;
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "turn/start") {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === "assistant/message") {
      const joined = event.data.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (joined !== "") text = joined;
    }
    if (event.type === "turn/end") reason = event.data.reason;
  }
  return { text, reason };
}

async function run(ctx, config, io) {
  await ctx.get("loader")?.await();

  const defaultModel = ctx.get("agentDefaultModel");
  const agents = ctx.get("agents");
  const sessions = ctx.get("sessions");
  if (defaultModel === undefined || agents === undefined || sessions === undefined) return;

  const selection = defaultModel.currentSelection();
  const shared = {
    agentOptions: {
      provider: selection.provider,
      model: selection.model,
    },
    setup: (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined });
    },
  };

  let agent;
  if (config.resumeSessionId) {
    const handle = await agents.resume({
      resumeSessionId: SessionId(config.resumeSessionId),
      ...shared,
    });
    agent = handle.agent;
    io.stderr.write(`[resume] session=${config.resumeSessionId} liveSeqs=${agent.session.events.length}\n`);
  } else {
    const sessionId = SessionId(`session-${randomUUID()}`);
    const handle = await agents.create({
      sessionId,
      meta: { cwd: process.cwd() },
      ...shared,
    });
    agent = handle.agent;
    io.stderr.write(`[create] session=${sessionId}\n`);
  }

  await agent.whenIdle();
  const firstSeq = agent.session.seq;
  agent.followup(createUserMessage({
    content: [{ type: "text", text: config.task }],
    source: { kind: "user" },
  }));
  await agent.whenIdle();
  await sessions.flush(agent.session);

  const outcome = summarize(agent.session.events, firstSeq);
  io.stdout.write(`${outcome.text}\n`);
  if (outcome.reason?.kind === "error") {
    io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`);
  }
  io.exit(outcome.reason?.kind === "completed" ? 0 : 1);
}

export function apply(ctx, config) {
  const exit = ctx.get("appExit");
  if (exit === undefined) {
    throw new Error("context-steady-e2e-runner: the launcher must provide ctx.appExit before the tree mounts");
  }
  const io = { stdout: process.stdout, stderr: process.stderr, exit };
  run(ctx, config, io).catch((error) => {
    io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`);
    io.exit(1);
  });
}
