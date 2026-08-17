/**
 * dsh-context-steady — San-style context steady state for DeepSeek Harness.
 *
 * This plugin transplants the core of San v0.1 "Context Steady" onto DSH's
 * public seams without modifying the agent loop:
 *
 *   - Every settled turn is folded into a structured TurnDigest. The
 *     deterministic fallback is pure regex/structure extraction; an optional
 *     LLM digest can upgrade it through a side `ctx.llm.stream` request.
 *   - Older digests roll up into a stable, budget-bounded checkpoint.
 *   - Before each step (after the compaction listeners have run) a bounded
 *     ContextPacket user message is appended to the session surface. When a
 *     span of raw surface nodes is covered by authoritative digests, that span
 *     and the previous packet are replaced by the new packet in ONE surface
 *     `replace` operation. The append-only event log never loses the raw span;
 *     only the provider-bound derived history is pruned. This is the DSH-native
 *     analogue of San's provider payload pruning.
 *   - `context_steady_expand` re-reads the raw journal span behind a digest
 *     ref (bounded output, oldest side truncated); `context_steady_status`
 *     exposes the ledger and budget audit to the model.
 *
 * Coverage safety follows San: the deterministic fallback digest carries
 * continuity but never authorizes raw-surface pruning unless
 * `prune.requireAuthoritativeDigest` is explicitly disabled. Only a successful
 * LLM digest marks a turn `authoritative`.
 *
 * Named exports follow the Cordis loader contract (`name` / `inject` /
 * `Config` / `apply`); the npm package declares `dsh.bundle.patch`.
 */

import z from "@deepseek-ai/schemastery";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { deriveEventMessage, isSurfaceEvent } from "@deepseek-ai/dsh-session";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z as zod } from "zod";

/** Cordis plugin name used by loader diagnostics. */
export const name = "context-steady";

/** Services required before this plugin can activate. */
export const inject = ["tools", "llm", "tokenMeter"];

/** Stable producer identity stamped on every packet user message. */
const PLUGIN_SOURCE = "dsh-context-steady";

/** Digest ref handed to the model; `context_steady_expand` resolves it. */
const DIGEST_REF_PREFIX = "dshcs:digest:";

/** Packet framing marker; also makes plugin-owned packets grep-able in logs. */
const PACKET_MARKER = "<dsh_context_steady_packet>";

/** Optional storage-domain sidecar holding authoritative LLM digests. */
const DIGEST_DOMAIN_NAME = "dsh_context_steady";

const finiteNumber = zod.number().finite();
const nonNegativeSafeInteger = zod.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const stringArraySchema = zod.array(zod.string());
const fileActionSchema = zod.union([
  zod.literal("read"), zod.literal("modified"), zod.literal("created"),
  zod.literal("deleted"), zod.literal("unknown"),
]);
const digestSchema = zod.object({
  schemaVersion: zod.literal(1),
  turnId: zod.string(),
  sessionId: zod.string(),
  createdAt: zod.string(),
  model: zod.string().optional(),
  source: zod.object({
    turn: nonNegativeSafeInteger,
    fromSeq: nonNegativeSafeInteger,
    toSeq: nonNegativeSafeInteger,
  }),
  userIntent: zod.string(),
  actionsTaken: stringArraySchema,
  decisions: stringArraySchema,
  filesTouched: zod.array(zod.object({
    path: zod.string(),
    action: fileActionSchema,
    reason: zod.string().optional(),
  })),
  toolEvidence: zod.array(zod.object({ tool: zod.string(), summary: zod.string() })),
  factsLearned: stringArraySchema,
  openQuestions: stringArraySchema,
  risks: stringArraySchema,
  nextSteps: stringArraySchema,
  memoryCandidates: zod.array(zod.object({
    content: zod.string(),
    type: zod.union([
      zod.literal("preference"), zod.literal("project_fact"), zod.literal("decision"),
      zod.literal("workflow"), zod.literal("other"),
    ]),
    importance: finiteNumber,
    authorization: zod.literal("inferred"),
  })),
  tokenStats: zod.object({
    input: finiteNumber,
    output: finiteNumber,
    cacheRead: finiteNumber,
    cacheWrite: finiteNumber,
    total: finiteNumber,
  }).optional(),
  fallback: zod.literal(false),
  fallbackReason: zod.undefined().optional(),
  authoritative: zod.literal(true),
});

const digestRowSchema = zod.object({
  sessionCreatedAt: nonNegativeSafeInteger,
  digests: zod.array(digestSchema),
});

const digestDomainSpec = defineDomain({
  name: DIGEST_DOMAIN_NAME,
  version: 0,
  tables: {
    sessions: domainTable(digestRowSchema),
  },
});

const DEFAULT_QUALITY_WINDOW_TOKENS = 240_000;
/** First digest/packet only after the current request estimate crosses this. */
const DEFAULT_ACTIVATION_THRESHOLD_TOKENS = 500_000;
const DEFAULT_RESERVE_RATIO = 0.25;
const DEFAULT_PACKET_MAX_TOKENS = 3_000;
const DEFAULT_CHECKPOINT_MAX_TOKENS = 12_000;
const DEFAULT_DIGEST_MAX_TOKENS = 768;
const DEFAULT_DIGEST_TIMEOUT_MS = 20_000;
const DEFAULT_DIGEST_TRANSCRIPT_CHARS = 12_000;
const DEFAULT_DIGEST_EVERY_TURNS = 4;
const DEFAULT_EXPAND_MAX_CHARS = 8_000;

const MAX_ARRAY_ITEMS = 20;
const MAX_FILE_ITEMS = 50;
const MAX_LLM_ACTIONS = 5;
const MAX_LLM_DECISIONS = 6;
const MAX_LLM_FACTS = 6;
const MAX_LLM_RISKS = 4;
const MAX_LLM_NEXT_STEPS = 4;
const MAX_LLM_MEMORY_CANDIDATES = 2;

const CHECKPOINT_LIMITS = {
  userIntents: 20,
  decisions: 20,
  filesTouched: 30,
  risks: 12,
  nextSteps: 12,
};

const CHECKPOINT_TRIM_ORDER = [
  "nextSteps",
  "risks",
  "filesTouched",
  "decisions",
  "userIntents",
];

const DIGEST_SYSTEM_PROMPT = [
  "You are the context-steady digester for a coding agent.",
  "For each input turn, produce one object with exactly these keys:",
  "userIntent (string), actionsTaken (string[], max 5), decisions (string[], max 6),",
  "filesTouched (array of {path, action: read|modified|created|deleted|unknown}, max 50),",
  "factsLearned (string[], max 6), openQuestions (string[]), risks (string[], max 4),",
  "nextSteps (string[], max 4), memoryCandidates (array of {content, type: preference|project_fact|decision|workflow|other, importance: number 0..1}, max 2).",
  "Every key is required. Use empty arrays when no evidence supports an item.",
  "Be terse and factual. Preserve exact paths, commands, identifiers, and error text.",
  "Return only valid JSON: one object for one turn, or one array in input order for multiple turns. No markdown fences or commentary.",
].join(" ");

/** Loader schema. Every field is optional and carries a default. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  activationThresholdTokens: z.number().step(1).min(0).default(DEFAULT_ACTIVATION_THRESHOLD_TOKENS),
  qualityWindowTokens: z.number().step(1).min(0).default(DEFAULT_QUALITY_WINDOW_TOKENS),
  reserveRatio: z.number().min(0).max(1).default(DEFAULT_RESERVE_RATIO),
  digest: z.object({
    enabled: z.boolean().default(true),
    everyTurns: z.number().step(1).min(1).max(100).default(DEFAULT_DIGEST_EVERY_TURNS),
    llm: z.object({
      enabled: z.boolean().default(false),
      provider: z.string(),
      model: z.string(),
      maxTokens: z.number().step(1).min(1).default(DEFAULT_DIGEST_MAX_TOKENS),
      timeoutMs: z.number().step(1).min(100).max(300000).default(DEFAULT_DIGEST_TIMEOUT_MS),
      maxTranscriptChars: z.number().step(1).min(1000).default(DEFAULT_DIGEST_TRANSCRIPT_CHARS),
    }).default({}),
  }).default({}),
  checkpoint: z.object({
    enabled: z.boolean().default(true),
    everyTurns: z.number().step(1).min(1).default(6),
    maxTokens: z.number().step(1).min(1).default(DEFAULT_CHECKPOINT_MAX_TOKENS),
  }).default({}),
  packet: z.object({
    enabled: z.boolean().default(true),
    recentDigests: z.number().step(1).min(1).max(20).default(5),
    maxTokens: z.number().step(1).min(0).max(256000).default(DEFAULT_PACKET_MAX_TOKENS),
  }).default({}),
  prune: z.object({
    enabled: z.boolean().default(true),
    requireAuthoritativeDigest: z.boolean().default(true),
  }).default({}),
  toolExpandMaxChars: z.number().step(1).min(100).max(100000).default(DEFAULT_EXPAND_MAX_CHARS),
});

/** Resolve config from a possibly partial object (tests / direct apply). */
function resolveConfig(config = {}) {
  const digest = config.digest ?? {};
  const llm = digest.llm ?? {};
  const checkpoint = config.checkpoint ?? {};
  const packet = config.packet ?? {};
  const prune = config.prune ?? {};
  return {
    enabled: config.enabled ?? true,
    activationThresholdTokens: clampNonNegativeInteger(config.activationThresholdTokens, DEFAULT_ACTIVATION_THRESHOLD_TOKENS),
    qualityWindowTokens: clampNonNegativeInteger(config.qualityWindowTokens, DEFAULT_QUALITY_WINDOW_TOKENS),
    reserveRatio: clampReserveRatio(config.reserveRatio ?? DEFAULT_RESERVE_RATIO),
    digest: {
      enabled: digest.enabled ?? true,
      everyTurns: Math.min(100, clampPositiveInteger(digest.everyTurns, DEFAULT_DIGEST_EVERY_TURNS)),
      llm: {
        enabled: llm.enabled ?? false,
        provider: typeof llm.provider === "string" && llm.provider.length > 0 ? llm.provider : "",
        model: typeof llm.model === "string" && llm.model.length > 0 ? llm.model : "",
        maxTokens: clampPositiveInteger(llm.maxTokens, DEFAULT_DIGEST_MAX_TOKENS),
        timeoutMs: Math.min(300_000, Math.max(100, clampPositiveInteger(llm.timeoutMs, DEFAULT_DIGEST_TIMEOUT_MS))),
        maxTranscriptChars: Math.max(1_000, clampPositiveInteger(llm.maxTranscriptChars, DEFAULT_DIGEST_TRANSCRIPT_CHARS)),
      },
    },
    checkpoint: {
      enabled: checkpoint.enabled ?? true,
      everyTurns: clampPositiveInteger(checkpoint.everyTurns, 6),
      maxTokens: clampPositiveInteger(checkpoint.maxTokens, DEFAULT_CHECKPOINT_MAX_TOKENS),
    },
    packet: {
      enabled: packet.enabled ?? true,
      recentDigests: Math.min(20, clampPositiveInteger(packet.recentDigests, 5)),
      maxTokens: Math.min(256_000, clampNonNegativeInteger(packet.maxTokens, DEFAULT_PACKET_MAX_TOKENS)),
    },
    prune: {
      enabled: prune.enabled ?? true,
      requireAuthoritativeDigest: prune.requireAuthoritativeDigest ?? true,
    },
    toolExpandMaxChars: Math.min(100_000, Math.max(100, clampPositiveInteger(config.toolExpandMaxChars, DEFAULT_EXPAND_MAX_CHARS))),
  };
}

function clampNonNegativeInteger(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function clampPositiveInteger(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function clampReserveRatio(value) {
  if (!Number.isFinite(value)) return DEFAULT_RESERVE_RATIO;
  return Math.min(1, Math.max(0, value));
}

function clampString(value, maxLength) {
  const text = String(value ?? "");
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function clampNarrative(value, maxLength) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return clampString(text, maxLength);
}

function clampStringArray(values, maxItems, maxLength) {
  const seen = new Set();
  const result = [];
  for (const value of values ?? []) {
    if (result.length >= maxItems) break;
    const text = clampNarrative(value, maxLength);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function isOwnPacket(message) {
  return (
    message?.role === "user"
    && message.source?.kind === "plugin"
    && message.source.plugin === PLUGIN_SOURCE
  );
}

function messageText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  const parts = [];
  const visit = (blocks) => {
    for (const block of blocks) {
      if (block?.type === "text") parts.push(block.text);
      else if (block?.type === "tool-result") visit(block.content ?? []);
    }
  };
  visit(message.content);
  return parts.join(" ").trim();
}

function firstTextLine(text, maxLength = 120) {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!line) return "";
  return line.length <= maxLength ? line : `${line.slice(0, maxLength - 3)}...`;
}

// ── Deterministic TurnDigest ─────────────────────────────────────────────────

function parseArguments(raw) {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function extractPath(args) {
  if (!args || typeof args !== "object") return undefined;
  for (const key of ["filePath", "file_path", "path", "src", "destination"]) {
    if (typeof args[key] === "string" && args[key].length > 0) return args[key];
  }
  return undefined;
}

const MUTATING_TOOLS = new Set([
  "write", "write_file", "edit", "edit_file", "apply_patch", "patch", "replace",
  "replace_in_file", "ast_edit", "notebook", "create_file", "mkdir",
]);

const READING_TOOLS = new Set([
  "read", "read_file", "glob", "grep", "search", "search_content", "list_files",
  "ls", "lsp", "stat",
]);

function guessFileAction(toolName) {
  if (MUTATING_TOOLS.has(toolName)) return "modified";
  if (READING_TOOLS.has(toolName)) return "read";
  return "unknown";
}

function collectFiles(toolCalls) {
  const seen = new Set();
  const files = [];
  for (const call of toolCalls) {
    const path = extractPath(call.args);
    if (path && !seen.has(path)) {
      seen.add(path);
      files.push({ path: clampString(path, 240), action: guessFileAction(call.name) });
    }
  }
  return files.slice(0, MAX_FILE_ITEMS);
}

function toolResultStatus(resultEvent) {
  const { data } = resultEvent;
  if (data.error) return "error";
  if (data.message?.content?.[0]?.isError === true) return "error";
  return "completed";
}

function collectToolEvidence(toolCalls, toolResultsByCallId) {
  const evidence = [];
  for (const call of toolCalls) {
    const result = toolResultsByCallId.get(String(call.callId));
    const status = result ? toolResultStatus(result) : "no_result";
    const path = extractPath(call.args);
    let summary = `${call.name}: ${status}`;
    if (status === "error" && result?.data?.error) {
      summary += ` — ${firstTextLine(result.data.error.message ?? String(result.data.error), 80)}`;
    }
    if (path) summary += ` (${path})`;
    evidence.push({ tool: call.name, summary: firstTextLine(summary, 180) });
  }
  return evidence.slice(0, MAX_ARRAY_ITEMS);
}

function collectLineMatches(texts, patterns) {
  const matches = [];
  for (const text of texts) {
    for (const rawLine of String(text ?? "").split("\n")) {
      const line = rawLine.replace(/^[-*]\s*/, "").trim();
      if (!line || !patterns.some((pattern) => pattern.test(line))) continue;
      matches.push(clampString(line, 120));
      if (matches.length >= MAX_ARRAY_ITEMS) return matches;
    }
  }
  return matches;
}

function collectDecisions(texts) {
  return collectLineMatches(texts, [
    /\b(I('ll| will)|let'?s|we('ll| will)|decided to|choosing to|going to|plan to|should)\b/i,
    /(决定|采用|选择|计划|方案是|改为|保持)/u,
  ]);
}

function collectFacts(texts) {
  return collectLineMatches(texts, [
    /\b(evidence|found|observed|confirmed|verified|result|shows|means)\b/i,
    /(证据|发现|观察到|确认|验证|结果|说明|表明)/u,
  ]);
}

function collectOpenQuestions(texts) {
  return collectLineMatches(texts, [
    /\b(open question|unknown|unclear|not covered|still need|needs follow-up)\b/i,
    /(未覆盖|不确定|还需要|待确认|待验证|开放问题)/u,
  ]);
}

function collectRisks(texts) {
  return collectLineMatches(texts, [
    /\b(risk|risky|could fail|may fail|edge case|not safe|over-prun|under-prun)\b/i,
    /(风险|可能失败|边界|误剪|过剪|漏剪|不安全)/u,
  ]);
}

function collectNextSteps(texts) {
  return collectLineMatches(texts, [
    /\b(next step|next|should|need to|follow[- ]?up|todo)\b/i,
    /(下一步|后续|应该|需要|待办|继续)/u,
  ]);
}

function collectTokenStats(events) {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const event of events) {
    if (event.type === "assistant/message" && event.data.usage) {
      input += event.data.usage.inputTokens ?? 0;
      output += event.data.usage.outputTokens ?? 0;
      cacheRead += event.data.usage.cacheReadTokens ?? 0;
      cacheWrite += event.data.usage.cacheWriteTokens ?? 0;
    }
  }
  const total = input + output;
  return total > 0 ? { input, output, cacheRead, cacheWrite, total } : undefined;
}

function collectMemoryCandidates(intent, decisions, facts) {
  const candidates = [];
  if (/\b(?:prefer|always|never|must|should)\b|(?:偏好|统一|始终|永远|不要|禁止|必须)/iu.test(intent)) {
    candidates.push({
      content: clampString(intent, 240),
      type: "preference",
      importance: 0.8,
      authorization: "inferred",
    });
  }
  for (const decision of decisions.slice(0, 6)) {
    candidates.push({
      content: decision,
      type: "decision",
      importance: 0.75,
      authorization: "inferred",
    });
  }
  for (const fact of facts.slice(0, 6)) {
    candidates.push({
      content: fact,
      type: "project_fact",
      importance: 0.7,
      authorization: "inferred",
    });
  }
  return candidates.slice(0, MAX_ARRAY_ITEMS);
}

/**
 * Build the deterministic fallback digest for one turn. Never throws and
 * always returns a schema-complete digest.
 */
function buildFallbackDigest(session, turn, spanEvents, reason = "llm_disabled") {
  const surfaceEvents = spanEvents.filter(isSurfaceEvent);
  const authoritativeUser = surfaceEvents.find(
    (event) => event.type === "user/message"
      && event.data.source?.kind === "user"
      && !isOwnPacket(event.data),
  );
  const intent = authoritativeUser
    ? firstTextLine(messageText(authoritativeUser.data), 200)
    : "System-driven continuation";

  const toolCalls = spanEvents
    .filter((event) => event.type === "tool/call")
    .map((event) => ({ callId: event.data.callId, name: event.data.name, args: parseArguments(event.data.arguments) }));
  const toolResultsByCallId = new Map(
    spanEvents
      .filter((event) => event.type === "tool/result")
      .map((event) => [String(event.data.callId ?? event.data.message?.source?.callId), event]),
  );
  const toolEvidence = collectToolEvidence(toolCalls, toolResultsByCallId);

  const assistantTexts = spanEvents
    .filter((event) => event.type === "assistant/message")
    .map((event) => messageText(event.data.message));
  const decisions = collectDecisions(assistantTexts);
  const factsLearned = collectFacts(assistantTexts);
  const openQuestions = collectOpenQuestions(assistantTexts);
  const risks = collectRisks(assistantTexts);
  const nextSteps = collectNextSteps(assistantTexts);

  const requestHeader = session.requestHeader?.();
  const model = requestHeader?.config?.provider && requestHeader.config.model
    ? `${requestHeader.config.provider}/${requestHeader.config.model}`
    : undefined;

  // The digest source starts at the authoritative user message, skipping the
  // packet/runtime-context prelude that belongs to the step, not the turn.
  const firstAuthoritative = spanEvents.find(
    (event) => event.type === "user/message" && event.data.source?.kind === "user" && !isOwnPacket(event.data),
  );
  const fromSeq = firstAuthoritative?.seq ?? spanEvents[0]?.seq ?? 0;
  const toSeq = spanEvents.at(-1)?.seq ?? 0;

  return {
    schemaVersion: 1,
    turnId: `turn_${turn}`,
    sessionId: String(session.id ?? ""),
    createdAt: new Date().toISOString(),
    model,
    source: {
      turn,
      fromSeq,
      toSeq,
    },
    userIntent: intent,
    actionsTaken: toolEvidence.map((entry) => entry.summary),
    decisions,
    filesTouched: collectFiles(toolCalls),
    toolEvidence,
    factsLearned,
    openQuestions,
    risks,
    nextSteps,
    memoryCandidates: collectMemoryCandidates(intent, decisions, factsLearned),
    tokenStats: collectTokenStats(spanEvents),
    fallback: true,
    fallbackReason: reason,
    authoritative: false,
  };
}

/** Surface messages for one turn, excluding plugin-owned context packets. */
function turnMessagesForLlm(events) {
  return events
    .filter((event) => isSurfaceEvent(event) && !isOwnPacket(event.data))
    .map((event) => deriveEventMessage(event))
    .filter(Boolean);
}

function formatMessageForDigest(message, entrySeq) {
  const blocks = (message.content ?? []).map((block) => {
    if (block.type === "text") return { type: "text", text: clampString(block.text, 1200) };
    if (block.type === "tool-call") {
      return {
        type: "tool-call",
        name: block.name,
        callId: String(block.callId ?? ""),
        arguments: block.arguments,
      };
    }
    if (block.type === "tool-result") {
      return {
        type: "tool-result",
        callId: String(block.callId ?? ""),
        isError: block.isError,
        content: Array.isArray(block.content)
          ? block.content.map((part) => (part?.type === "text" ? { type: "text", text: clampString(part.text, 800) } : part))
          : block.content,
      };
    }
    return block;
  });
  return {
    seq: entrySeq,
    role: message.role,
    content: blocks,
  };
}

function extractJsonObjectFromText(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return undefined;
  const candidates = [];
  for (let start = 0; start < trimmed.length; start += 1) {
    if (trimmed[start] !== "{") continue;
    let depth = 0;
    let end = -1;
    let inString = false;
    let escaped = false;
    for (let index = start; index < trimmed.length; index += 1) {
      const char = trimmed[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end < 0) continue;
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidates.push(parsed);
      }
    } catch {
      // Keep scanning candidate braces.
    }
  }
  // Prefer the object that carries the digest's required keys; this avoids
  // picking a nested file/memory object out of the middle of the response.
  return candidates.find((candidate) => typeof candidate.userIntent === "string")
    ?? candidates[0];
}

function extractJsonArrayFromText(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return undefined;
  for (let start = 0; start < trimmed.length; start += 1) {
    if (trimmed[start] !== "[") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < trimmed.length; index += 1) {
      const char = trimmed[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "[") depth += 1;
      else if (char === "]") {
        depth -= 1;
        if (depth !== 0) continue;
        try {
          const parsed = JSON.parse(trimmed.slice(start, index + 1));
          if (Array.isArray(parsed)) return parsed;
        } catch {
          break;
        }
      }
    }
  }
  return undefined;
}

function finishError(finish) {
  if (!finish || finish.kind === "stop") return undefined;
  const failure = finish.reason?.failure;
  if (finish.kind === "max-tokens") {
    return new Error("LLM digest truncated at the token cap (incomplete structured digest)");
  }
  return new Error(failure?.message ?? `digest stream finished with ${String(finish.kind)}`);
}

function normalizeLlmDigest(raw, fallback) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const intent = clampNarrative(raw.userIntent, 240);
  if (!intent) return undefined;

  const fileAction = (action) => (
    ["read", "modified", "created", "deleted", "unknown"].includes(action) ? action : "unknown"
  );
  const files = Array.isArray(raw.filesTouched)
    ? raw.filesTouched.slice(0, MAX_FILE_ITEMS)
      .map((file) => file && typeof file.path === "string"
        ? { path: clampString(file.path, 240), action: fileAction(file.action), reason: typeof file.reason === "string" ? clampString(file.reason, 200) : undefined }
        : undefined)
      .filter(Boolean)
    : [];
  // Fallback files are authoritative evidence and are never dropped.
  const filesByPath = new Map(fallback.filesTouched.map((file) => [file.path, { ...file }]));
  for (const file of files) filesByPath.set(file.path, { ...filesByPath.get(file.path), ...file });
  const mergedFiles = [...filesByPath.values()].slice(0, MAX_FILE_ITEMS);

  const memoryCandidates = (Array.isArray(raw.memoryCandidates) ? raw.memoryCandidates : [])
    .slice(0, MAX_LLM_MEMORY_CANDIDATES)
    .map((candidate) => ({
      content: clampNarrative(candidate?.content, 240),
      type: ["preference", "project_fact", "decision", "workflow", "other"].includes(candidate?.type)
        ? candidate.type
        : "other",
      importance: Number.isFinite(candidate?.importance)
        ? Math.min(1, Math.max(0, candidate.importance))
        : 0.5,
      authorization: "inferred",
    }))
    .filter((candidate) => candidate.content.length > 0);

  return {
    ...fallback,
    model: fallback.model,
    userIntent: intent,
    actionsTaken: clampStringArray(raw.actionsTaken, MAX_LLM_ACTIONS, 180),
    decisions: clampStringArray(raw.decisions, MAX_LLM_DECISIONS, 180),
    filesTouched: mergedFiles,
    toolEvidence: fallback.toolEvidence,
    factsLearned: clampStringArray(raw.factsLearned, MAX_LLM_FACTS, 180),
    openQuestions: clampStringArray(raw.openQuestions, 8, 180),
    risks: clampStringArray(raw.risks, MAX_LLM_RISKS, 180),
    nextSteps: clampStringArray(raw.nextSteps, MAX_LLM_NEXT_STEPS, 180),
    memoryCandidates,
    tokenStats: fallback.tokenStats,
    fallback: false,
    fallbackReason: undefined,
    authoritative: true,
  };
}

// ── Checkpoint and packet building ──────────────────────────────────────────

function estimateUserText(meter, text) {
  if (!text) return 0;
  try {
    return Math.max(0, meter.estimateMessage(createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: "plugin", plugin: PLUGIN_SOURCE },
    })));
  } catch {
    return Math.ceil(text.length / 4);
  }
}

function summaryItem(text, turn) {
  return { text: clampNarrative(text, 180), turns: [turn] };
}

function mergeSummaryItems(stable, appended, maxItems) {
  const byKey = new Map();
  for (const item of stable ?? []) {
    const key = String(item.text).toLowerCase();
    byKey.set(key, { text: item.text, turns: [...(item.turns ?? [])] });
  }
  for (const item of appended) {
    const key = String(item.text).toLowerCase();
    const existing = byKey.get(key);
    if (existing) existing.turns = [...new Set([...existing.turns, ...item.turns])];
    else byKey.set(key, { text: item.text, turns: [...item.turns] });
  }
  return [...byKey.values()].slice(0, maxItems);
}

/** Merge file items while preserving the `action` discriminator. */
function mergeFileItems(stable, appended, maxItems) {
  const byKey = new Map();
  for (const item of stable ?? []) {
    const key = `${String(item.text).toLowerCase()}|${item.action ?? "unknown"}`;
    byKey.set(key, {
      text: item.text,
      action: item.action ?? "unknown",
      turns: [...(item.turns ?? [])],
    });
  }
  for (const item of appended) {
    const key = `${String(item.text).toLowerCase()}|${item.action ?? "unknown"}`;
    const existing = byKey.get(key);
    if (existing) existing.turns = [...new Set([...existing.turns, ...item.turns])];
    else byKey.set(key, {
      text: item.text,
      action: item.action ?? "unknown",
      turns: [...item.turns],
    });
  }
  return [...byKey.values()].slice(0, maxItems);
}

function checkpointSummaryFromDigests(digests) {
  const filesByKey = new Map();
  for (const digest of digests) {
    for (const file of (digest.filesTouched ?? []).slice(0, 5)) {
      const key = `${file.path}:${file.action}`;
      if (!filesByKey.has(key)) {
        filesByKey.set(key, {
          text: clampNarrative(file.path, 240),
          action: file.action,
          turns: [digest.source.turn],
        });
      }
    }
  }
  return {
    userIntents: mergeSummaryItems(
      [],
      digests.map((digest) => summaryItem(digest.userIntent, digest.source.turn)),
      CHECKPOINT_LIMITS.userIntents,
    ),
    decisions: mergeSummaryItems(
      [],
      digests.flatMap((digest) => (digest.decisions ?? []).slice(0, 3)
        .map((text) => summaryItem(text, digest.source.turn))),
      CHECKPOINT_LIMITS.decisions,
    ),
    filesTouched: [...filesByKey.values()].slice(0, CHECKPOINT_LIMITS.filesTouched),
    risks: mergeSummaryItems(
      [],
      digests.flatMap((digest) => (digest.risks ?? []).slice(0, 2)
        .map((text) => summaryItem(text, digest.source.turn))),
      CHECKPOINT_LIMITS.risks,
    ),
    nextSteps: mergeSummaryItems(
      [],
      digests.flatMap((digest) => (digest.nextSteps ?? []).slice(0, 2)
        .map((text) => summaryItem(text, digest.source.turn))),
      CHECKPOINT_LIMITS.nextSteps,
    ),
  };
}

function cloneSummary(summary) {
  return {
    userIntents: (summary.userIntents ?? []).map((item) => ({ ...item, turns: [...(item.turns ?? [])] })),
    decisions: (summary.decisions ?? []).map((item) => ({ ...item, turns: [...(item.turns ?? [])] })),
    filesTouched: (summary.filesTouched ?? []).map((item) => ({ ...item, turns: [...(item.turns ?? [])] })),
    risks: (summary.risks ?? []).map((item) => ({ ...item, turns: [...(item.turns ?? [])] })),
    nextSteps: (summary.nextSteps ?? []).map((item) => ({ ...item, turns: [...(item.turns ?? [])] })),
  };
}

function trimCheckpointTail(checkpoint) {
  for (const field of CHECKPOINT_TRIM_ORDER) {
    const keep = field === "userIntents" ? 1 : 0;
    if (checkpoint.summary[field].length > keep) {
      const summary = { ...checkpoint.summary, [field]: checkpoint.summary[field].slice(0, -1) };
      return { ...checkpoint, summary };
    }
  }
  return checkpoint;
}

function checkpointDigestRevision(digests) {
  return JSON.stringify(digests.map((digest) => [
    digest.source.turn,
    digest.authoritative,
    digest.userIntent,
    digest.decisions,
    digest.filesTouched,
    digest.risks,
    digest.nextSteps,
  ]));
}

function buildCheckpoint(state, cfg, meter) {
  if (!cfg.checkpoint.enabled) return;
  const targetCount = Math.floor(state.digests.length / cfg.checkpoint.everyTurns)
    * cfg.checkpoint.everyTurns;
  if (targetCount === 0) return;
  const selected = state.digests.slice(0, targetCount);
  const revision = checkpointDigestRevision(selected);
  if (state.checkpoint?.digestRevision === revision) return;
  const summary = checkpointSummaryFromDigests(selected);
  let checkpoint = {
    schemaVersion: 2,
    checkpointId: `ckpt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    digestCount: selected.length,
    digestRevision: revision,
    coveredTurnSet: new Set(selected.map((digest) => digest.source.turn)),
    summary,
    tokenBudget: cfg.checkpoint.maxTokens,
    tokenEstimate: 0,
  };
  checkpoint = {
    ...checkpoint,
    tokenEstimate: estimateUserText(meter, JSON.stringify(checkpoint.summary)),
  };
  while (checkpoint.tokenEstimate > cfg.checkpoint.maxTokens) {
    const next = trimCheckpointTail(checkpoint);
    if (next.summary === checkpoint.summary) break;
    checkpoint = {
      ...next,
      tokenEstimate: estimateUserText(meter, JSON.stringify(next.summary)),
    };
  }
  if (checkpoint.tokenEstimate > cfg.checkpoint.maxTokens) {
    let maxLen = 120;
    while (checkpoint.tokenEstimate > cfg.checkpoint.maxTokens && maxLen >= 8) {
      const clampItems = (items) => items.map((item) => ({ ...item, text: clampString(item.text, maxLen) }));
      const summary = {
        userIntents: clampItems(checkpoint.summary.userIntents),
        decisions: clampItems(checkpoint.summary.decisions),
        filesTouched: checkpoint.summary.filesTouched.map((item) => ({ ...item, text: clampString(item.text, maxLen) })),
        risks: clampItems(checkpoint.summary.risks),
        nextSteps: clampItems(checkpoint.summary.nextSteps),
      };
      checkpoint = { ...checkpoint, summary, tokenEstimate: estimateUserText(meter, JSON.stringify(summary)) };
      maxLen = Math.floor(maxLen / 2);
    }
  }
  if (checkpoint.tokenEstimate > cfg.checkpoint.maxTokens) return;
  state.checkpoint = checkpoint;
}

function renderPacket(digests, checkpoint) {
  const lines = [PACKET_MARKER];
  lines.push("This is the context steady packet for the current turn. It carries concise continuity from earlier settled turns. The user's current prompt remains authoritative.");
  if (checkpoint) {
    lines.push("", "Stable checkpoint:");
    const s = checkpoint.summary;
    lines.push(`  userIntents:${s.userIntents.length ? ` ${s.userIntents.map((item) => item.text).join("; ")};` : " none"}`);
    lines.push(`  decisions:${s.decisions.length ? ` ${s.decisions.map((item) => item.text).join("; ")};` : " none"}`);
    lines.push(`  filesTouched:${s.filesTouched.length ? ` ${s.filesTouched.map((item) => `${item.text} (${item.action})`).join("; ")};` : " none"}`);
    lines.push(`  risks:${s.risks.length ? ` ${s.risks.map((item) => item.text).join("; ")};` : " none"}`);
    lines.push(`  nextSteps:${s.nextSteps.length ? ` ${s.nextSteps.map((item) => item.text).join("; ")};` : " none"}`);
  }
  lines.push("", "Recent turn digests (pass a ref to context_steady_expand to re-read the raw span):");
  if (digests.length === 0) {
    lines.push("  none");
  } else {
    for (const digest of digests) {
      const ref = `${DIGEST_REF_PREFIX}${digest.source.turn}`;
      lines.push(`- Turn ${digest.source.turn} [ref: ${ref}]:`);
      lines.push(`  userIntent: ${digest.userIntent}`);
      lines.push(`  actionsTaken:${digest.actionsTaken.length ? ` ${digest.actionsTaken.join("; ")};` : " none"}`);
      lines.push(`  decisions:${digest.decisions.length ? ` ${digest.decisions.join("; ")};` : " none"}`);
      lines.push(`  filesTouched:${digest.filesTouched.length ? ` ${digest.filesTouched.map((file) => `${file.path} (${file.action})`).join("; ")};` : " none"}`);
      lines.push(`  risks:${digest.risks.length ? ` ${digest.risks.join("; ")};` : " none"}`);
      lines.push(`  nextSteps:${digest.nextSteps.length ? ` ${digest.nextSteps.join("; ")};` : " none"}`);
    }
  }
  return lines.join("\n");
}

function buildPacket(state, cfg, meter) {
  const budget = packetBudget(cfg);
  if (budget <= 0) return null;

  const checkpointChanged = state.checkpoint
    && state.lastPacket?.checkpointRef !== state.checkpoint.checkpointId;
  const checkpoint = checkpointChanged ? state.checkpoint : undefined;
  const coveredTurns = state.checkpoint?.coveredTurnSet ?? new Set();
  let digests = state.digests
    .filter((digest) => !coveredTurns.has(digest.source.turn))
    .slice(-cfg.packet.recentDigests);

  let content = renderPacket(digests, checkpoint ? { ...checkpoint, summary: cloneSummary(checkpoint.summary) } : undefined);
  let estimate = estimateUserText(meter, content);
  let digestTokenTrimmed = 0;

  while (estimate > budget && digests.length > 1) {
    digests = digests.slice(1);
    digestTokenTrimmed += 1;
    content = renderPacket(digests, checkpoint ? { ...checkpoint, summary: cloneSummary(checkpoint.summary) } : undefined);
    estimate = estimateUserText(meter, content);
  }

  let trimmedCheckpoint;
  let checkpointTrimmed = 0;
  if (checkpoint) {
    trimmedCheckpoint = { ...checkpoint, summary: cloneSummary(checkpoint.summary) };
    while (estimate > budget) {
      const next = trimCheckpointTail(trimmedCheckpoint);
      if (next.summary === trimmedCheckpoint.summary) break;
      trimmedCheckpoint = next;
      checkpointTrimmed += 1;
      content = renderPacket(digests, { ...trimmedCheckpoint, summary: cloneSummary(trimmedCheckpoint.summary) });
      estimate = estimateUserText(meter, content);
    }
  }

  if (estimate > budget || (digests.length === 0 && !trimmedCheckpoint)) return null;

  return {
    content,
    estimate,
    budget,
    digestRefs: digests.map((digest) => `${DIGEST_REF_PREFIX}${digest.source.turn}`),
    digests,
    checkpoint: trimmedCheckpoint,
    checkpointRef: checkpoint?.checkpointId,
    digestTokenTrimmed,
    checkpointTrimmed,
  };
}

function packetBudget(cfg) {
  if (cfg.qualityWindowTokens > 0) {
    const reserved = Math.floor(cfg.qualityWindowTokens * cfg.reserveRatio);
    return Math.min(cfg.packet.maxTokens, Math.max(0, cfg.qualityWindowTokens - reserved));
  }
  return cfg.packet.maxTokens;
}

// ── Per-session state machine ────────────────────────────────────────────────

class SessionSteadyState {
  constructor(session, cfg) {
    this.session = session;
    this.cfg = cfg;
    this.consumed = 0;
    this.activated = false;
    this.currentTurn = 0;
    this.digests = [];
    this.digestsByTurn = new Map();
    this.turnSpans = new Map();
    this.checkpoint = undefined;
    this.lastPacket = undefined;
    this.coveredSeqs = new Set();
    this.hasOwnPacketInLog = false;
    this.sidecarLoaded = false;
    this.sidecarDigests = 0;
    this.sidecarAvailable = false;
  }

  sync(session = this.session) {
    const events = session.events;
    while (this.consumed < events.length) {
      const event = events[this.consumed];
      this.consumed += 1;
      this.applyEvent(event);
    }
  }

  applyEvent(event) {
    if (event.type === "turn/start") {
      this.currentTurn = event.data.turn;
      this.turnSpans.set(event.data.turn, { turn: event.data.turn, fromSeq: event.seq + 1, toSeq: undefined });
      return;
    }
    if (event.type === "user/message" && isOwnPacket(event.data)) {
      this.hasOwnPacketInLog = true;
      if (!this.activated) this.activateFromHistory();
      for (const seq of event.sourceEventSeqs ?? []) this.coveredSeqs.add(seq);
      this.lastPacket = {
        seq: event.seq,
        coveredSeqs: new Set(event.sourceEventSeqs ?? []),
        checkpointRef: undefined,
        forTurn: (this.currentTurn ?? 0) + 1,
      };
      return;
    }
    if (event.type === "turn/end") {
      const span = this.turnSpans.get(event.data.turn);
      if (span) {
        span.toSeq = Math.max(span.fromSeq, event.seq - 1);
        if (this.activated && !this.digestsByTurn.has(event.data.turn)) {
          this.finishDigestFromHistory(event.data.turn, span);
        }
      }
      return;
    }
  }

  activateFromHistory() {
    this.activated = true;
    for (const [turn, span] of this.turnSpans) {
      if (span.toSeq !== undefined && !this.digestsByTurn.has(turn)) {
        this.finishDigestFromHistory(turn, span);
      }
    }
  }

  finishDigestFromHistory(turn, span) {
    const events = this.session.events.slice(span.fromSeq, span.toSeq + 1);
    if (events.length === 0) return;
    const digest = buildFallbackDigest(this.session, turn, events, "resume_replay");
    this.storeDigest(digest);
  }

  storeDigest(digest) {
    const existing = this.digestsByTurn.get(digest.source.turn);
    if (existing && !existing.fallback && digest.fallback) return;
    this.digestsByTurn.set(digest.source.turn, digest);
    this.digests = [...this.digests.filter((entry) => entry.source.turn !== digest.source.turn), digest]
      .sort((a, b) => a.source.turn - b.source.turn);
  }

  restoreAuthoritativeDigests(digests) {
    if (!Array.isArray(digests) || digests.length === 0) {
      this.sidecarLoaded = true;
      this.sidecarDigests = 0;
      return;
    }
    let restored = 0;
    for (const digest of digests) {
      if (digest.sessionId !== String(this.session.id)) continue;
      const span = this.turnSpans.get(digest.source.turn);
      if (!span || span.toSeq === undefined) continue;
      if (span.fromSeq > digest.source.fromSeq || span.toSeq < digest.source.toSeq) continue;
      this.storeDigest(digest);
      restored += 1;
    }
    this.sidecarLoaded = true;
    this.sidecarDigests = restored;
    if (restored > 0 && !this.activated) this.activateFromHistory();
  }

  markCoverage(digest, cfg) {
    if (!cfg.prune.enabled) return;
    if (cfg.prune.requireAuthoritativeDigest && !digest.authoritative) return;
    const events = this.session.events;
    for (const seq of this.session.surface.nodes) {
      if (seq < digest.source.fromSeq || seq > digest.source.toSeq) continue;
      // Plugin-owned user messages (packet snapshots, runtime context, skills)
      // are not part of the turn's raw evidence and are never coverage-pruned
      // here; the previous packet is replaced through the packet path instead.
      const event = events[seq];
      if (event?.type === "user/message" && event.data.source?.kind !== "user") continue;
      this.coveredSeqs.add(seq);
    }
  }

  /**
   * Sticky activation. Before activation the plugin is native-equivalent:
   * it only measures, produces no digest and injects no packet. Once a packet
   * exists in the log (resume) or the request crosses the token threshold,
   * activation is permanent for this session object.
   */
  ensureActivation(measurement, cfg) {
    if (this.activated) return;
    const threshold = cfg.activationThresholdTokens;
    const total = measurement?.totalTokens ?? Number.POSITIVE_INFINITY;
    if (this.hasOwnPacketInLog || threshold === 0 || total >= threshold) {
      this.activated = true;
      for (const [turn, span] of this.turnSpans) {
        if (span.toSeq !== undefined && !this.digestsByTurn.has(turn)) {
          this.finishDigestFromHistory(turn, span);
        }
      }
    }
  }

  /** The contiguous covered surface block the next packet may shadow. */
  coveredBlock() {
    const nodes = this.session.surface.nodes;
    if (nodes.length === 0) return null;
    if (this.lastPacket && nodes.includes(this.lastPacket.seq)) {
      const startIndex = nodes.indexOf(this.lastPacket.seq);
      let endIndex = startIndex;
      for (let index = startIndex + 1; index < nodes.length; index += 1) {
        if (!this.coveredSeqs.has(nodes[index])) break;
        endIndex = index;
      }
      return {
        start: nodes[startIndex],
        end: nodes[endIndex],
        shadowed: nodes.slice(startIndex, endIndex + 1),
      };
    }
    let startIndex = nodes.length;
    while (startIndex > 0 && this.coveredSeqs.has(nodes[startIndex - 1])) startIndex -= 1;
    if (startIndex >= nodes.length) return null;
    return {
      start: nodes[startIndex],
      end: nodes[nodes.length - 1],
      shadowed: nodes.slice(startIndex),
    };
  }
}

const stateBySession = new WeakMap();

function stateFor(session, cfg) {
  let state = stateBySession.get(session);
  if (!state) {
    state = new SessionSteadyState(session, cfg);
    stateBySession.set(session, state);
  } else {
    state.cfg = cfg;
  }
  return state;
}

// ── LLM digest side request ──────────────────────────────────────────────────

function digestTarget(cfg, agent) {
  if (cfg.digest.llm.provider && cfg.digest.llm.model) {
    return { provider: cfg.digest.llm.provider, model: cfg.digest.llm.model };
  }
  const header = agent.session.requestHeader?.();
  if (header?.config?.provider && header.config.model) {
    return { provider: header.config.provider, model: header.config.model };
  }
  if (agent.options?.provider && agent.options?.model) {
    return { provider: agent.options.provider, model: agent.options.model };
  }
  return undefined;
}

function pendingDigestTurns(state, throughTurn, cfg) {
  const interval = cfg.digest.everyTurns;
  const pending = [];
  for (const [turn, span] of state.turnSpans) {
    if (turn > throughTurn || span.toSeq === undefined) continue;
    const digest = state.digestsByTurn.get(turn);
    if (!digest?.authoritative) pending.push(turn);
  }
  return pending.sort((a, b) => a - b).slice(-interval);
}

function shouldRequestLlmDigest(state, throughTurn, cfg, pendingTurns) {
  if (!cfg.digest.llm.enabled || pendingTurns.length === 0) return false;
  return throughTurn % cfg.digest.everyTurns === 0;
}

async function requestLlmDigestBatch(ctx, cfg, agent, fallbacks, spanEventsByTurn, signal) {
  const target = digestTarget(cfg, agent);
  if (!target) {
    throw new Error("no provider/model available for LLM digest");
  }
  const turns = fallbacks.map((fallback) => {
    const spanEvents = spanEventsByTurn.get(fallback.source.turn) ?? [];
    return {
      source: fallback.source,
      fallbackEvidence: {
        userIntent: fallback.userIntent,
        filesTouched: fallback.filesTouched,
        toolEvidence: fallback.toolEvidence,
        tokenStats: fallback.tokenStats,
      },
      turnSpan: turnMessagesForLlm(spanEvents)
        .map((message) => formatMessageForDigest(message, undefined)),
    };
  });
  const payload = JSON.stringify({ turns });
  const body = payload.length <= cfg.digest.llm.maxTranscriptChars
    ? payload
    : `${payload.slice(0, cfg.digest.llm.maxTranscriptChars)}\n...[truncated for digest generation]`;

  const timeoutSignal = AbortSignal.timeout(cfg.digest.llm.timeoutMs);
  const callSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const assembler = new BlockAssembler();
  const system = fallbacks.length === 1
    ? DIGEST_SYSTEM_PROMPT
    : `${DIGEST_SYSTEM_PROMPT} Input contains multiple turns. Return exactly one JSON array in input order, with one digest object per turn.`;
  for await (const chunk of ctx.llm.stream({
    provider: target.provider,
    model: target.model,
    messages: [
      createUserMessage({
        content: [{ type: "text", text: body }],
        source: { kind: "plugin", plugin: PLUGIN_SOURCE },
      }),
    ],
    system,
    maxTokens: cfg.digest.llm.maxTokens,
    sessionId: agent.session.id,
    signal: callSignal,
  })) {
    assembler.push(chunk);
  }
  const error = finishError(assembler.finish);
  if (error) throw error;
  if (process.env.CONTEXT_STEADY_BENCH) {
    const first = fallbacks[0].source.turn;
    const last = fallbacks.at(-1).source.turn;
    console.error(`[context-steady digest-usage] turns=${first}-${last} count=${fallbacks.length} `
      + `input=${assembler.usage?.inputTokens ?? 0} output=${assembler.usage?.outputTokens ?? 0} `
      + `cacheRead=${assembler.usage?.cacheReadTokens ?? 0} cacheWrite=${assembler.usage?.cacheWriteTokens ?? 0}`);
  }
  const text = assembler.blocks().filter((block) => block.type === "text").map((block) => block.text).join("\n");
  let rawDigests;
  try {
    const parsed = JSON.parse(text.trim());
    rawDigests = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    rawDigests = extractJsonArrayFromText(text);
    if (!rawDigests) rawDigests = fallbacks.length === 1 ? [extractJsonObjectFromText(text)] : [];
  }
  if (rawDigests.length !== fallbacks.length) {
    throw new Error(`provider returned ${rawDigests.length} digests for ${fallbacks.length} turns`);
  }
  const normalized = rawDigests.map((raw, index) => normalizeLlmDigest(raw, fallbacks[index]));
  if (normalized.some((digest) => !digest)) {
    throw new Error("provider did not return structured turn digests");
  }
  return normalized;
}

function digestFallbackReason(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/no provider\/model/.test(message)) return "model_unresolved";
  if (/timeout|abort/i.test(message)) return "timeout";
  if (/structured turn digest|structured turn digests|returned .* digests|json/i.test(message)) return "structured_output_invalid";
  return "request_failed";
}

async function generateTurnDigests(ctx, cfg, agent, state, throughTurn, signal) {
  const pendingTurns = pendingDigestTurns(state, throughTurn, cfg);
  const fallbacks = [];
  const spanEventsByTurn = new Map();
  for (const turn of pendingTurns) {
    const span = state.turnSpans.get(turn);
    const toSeq = span?.toSeq ?? agent.session.events.length - 1;
    const events = span ? agent.session.events.slice(span.fromSeq, toSeq + 1) : [];
    if (events.length === 0) continue;
    spanEventsByTurn.set(turn, events);
    const fallback = buildFallbackDigest(agent.session, turn, events, "llm_pending");
    fallbacks.push(fallback);
    state.storeDigest(fallback);
  }
  if (!cfg.digest.enabled || !shouldRequestLlmDigest(state, throughTurn, cfg, pendingTurns)) return [];
  try {
    const digests = await requestLlmDigestBatch(ctx, cfg, agent, fallbacks, spanEventsByTurn, signal);
    for (const digest of digests) state.storeDigest(digest);
    return digests;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger?.warn?.(
      `dsh-context-steady: LLM digest batch through turn ${throughTurn} failed (${message}); keeping fallbacks`,
    );
    const reason = digestFallbackReason(error);
    for (const fallback of fallbacks) state.storeDigest({ ...fallback, fallbackReason: reason });
    return [];
  }
}

// ── Surface packet emission ──────────────────────────────────────────────────

function emitPacket(ctx, cfg, agent, state, meter, forTurn) {
  const built = buildPacket(state, cfg, meter);
  if (!built) return;
  const message = createUserMessage({
    content: [{ type: "text", text: built.content }],
    source: {
      kind: "plugin",
      plugin: PLUGIN_SOURCE,
      form: "snapshot",
      sections: [{ name: "context-steady", text: built.content }],
    },
  });

  // Even when raw pruning is disabled, the newest packet must supersede the
  // previous one so packet snapshots never accumulate on the surface.
  let block = null;
  if (cfg.prune.enabled) {
    block = state.coveredBlock();
  } else if (state.lastPacket && agent.session.surface.nodes.includes(state.lastPacket.seq)) {
    block = {
      start: state.lastPacket.seq,
      end: state.lastPacket.seq,
      shadowed: [state.lastPacket.seq],
    };
  }
  let event;
  if (block && block.shadowed.length > 0) {
    event = agent.session.append("user/message", message, {
      surfaceOp: { op: "replace", start: block.start, end: block.end },
      sourceEventSeqs: [...block.shadowed],
    });
  } else {
    event = agent.session.append("user/message", message, { surfaceOp: "append" });
  }

  state.lastPacket = {
    seq: event.seq,
    coveredSeqs: new Set(event.sourceEventSeqs ?? []),
    checkpointRef: built.checkpointRef,
    packetTokens: built.estimate,
    forTurn: forTurn ?? state.currentTurn,
  };
  for (const seq of event.sourceEventSeqs ?? []) state.coveredSeqs.add(seq);

  if (process.env.CONTEXT_STEADY_BENCH) {
    console.error(`[context-steady packet] seq=${event.seq} forTurn=${forTurn} `
      + `op=${event.surfaceOp === "append" ? "append" : `replace:${block.start}-${block.end}`} `
      + `tokens=${built.estimate} shadowed=${block?.shadowed.length ?? 0}`);
  }

  ctx.logger?.debug?.(`dsh-context-steady: packet seq ${event.seq} (${event.surfaceOp === "append" ? "append" : `replace ${block.start}-${block.end}`}, ${built.estimate} tokens)`);
}

// ── Tools ────────────────────────────────────────────────────────────────────

function statusTool(cfg, pluginCtx, resolveState = (session) => stateFor(session, cfg)) {
  return defineTool({
    name: "context_steady_status",
    description:
      "Report the context-steady ledger for the current session: turn digests, checkpoint coverage, packet budget, and surface pruning audit.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          activated: { type: "boolean" },
          turns: { type: "integer" },
          digests: { type: "integer" },
          authoritativeDigests: { type: "integer" },
          sidecarAvailable: { type: "boolean" },
          sidecarLoaded: { type: "boolean" },
          sidecarDigests: { type: "integer" },
          checkpointTurns: { type: "integer" },
          packetOnSurface: { type: "boolean" },
          packetTokens: { type: "integer" },
          packetBudget: { type: "integer" },
          surfaceTokens: { type: "integer" },
          totalTokens: { type: "integer" },
          coveredSurfaceNodes: { type: "integer" },
          lastPacketSeq: { type: "integer" },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: "text",
          text: [
            `context-steady: ${value.enabled ? "enabled" : "disabled"}${value.activated ? ", activated" : ", not activated"}`,
            `turns=${value.turns} digests=${value.digests} authoritative=${value.authoritativeDigests} checkpointTurns=${value.checkpointTurns}`,
            `sidecar: ${value.sidecarAvailable ? "available" : "unavailable"}, loaded=${value.sidecarLoaded}, digests=${value.sidecarDigests}`,
            `packet: ${value.packetOnSurface ? `seq ${value.lastPacketSeq}` : "none"}, ${value.packetTokens}/${value.packetBudget} tokens`,
            `surface=${value.surfaceTokens} tokens, request=${value.totalTokens} tokens, coveredNodes=${value.coveredSurfaceNodes}`,
          ].join("\n"),
        },
      ],
    },
    async execute(_args, exec) {
      const session = exec.agent?.session;
      const state = session ? resolveState(session) : undefined;
      if (!session || !state) {
        return {
          enabled: cfg.enabled, activated: false, turns: 0, digests: 0, authoritativeDigests: 0,
          sidecarAvailable: false, sidecarLoaded: false, sidecarDigests: 0,
          checkpointTurns: 0, packetOnSurface: false, packetTokens: 0, packetBudget: packetBudget(cfg),
          surfaceTokens: 0, totalTokens: 0, coveredSurfaceNodes: 0, lastPacketSeq: -1,
        };
      }
      state.sync(session);
      const meter = pluginCtx?.tokenMeter;
      let measurement;
      try {
        measurement = meter?.measure?.(session);
      } catch {
        measurement = undefined;
      }
      if (!state.activated && measurement) {
        state.ensureActivation(measurement, cfg);
      }
      const packetOnSurface = state.lastPacket ? session.surface.nodes.includes(state.lastPacket.seq) : false;
      let packetTokens = state.lastPacket?.packetTokens;
      if (packetTokens === undefined && state.lastPacket && session.events[state.lastPacket.seq]?.type === "user/message") {
        packetTokens = meter
          ? meter.estimateMessage(session.events[state.lastPacket.seq].data)
          : Math.ceil(JSON.stringify(session.events[state.lastPacket.seq].data).length / 4);
      }
      return {
        enabled: cfg.enabled,
        activated: state.activated,
        turns: state.turnSpans.size,
        digests: state.digests.length,
        authoritativeDigests: state.digests.filter((digest) => digest.authoritative).length,
        sidecarAvailable: state.sidecarAvailable,
        sidecarLoaded: state.sidecarLoaded,
        sidecarDigests: state.sidecarDigests,
        checkpointTurns: state.checkpoint?.coveredTurnSet.size ?? 0,
        packetOnSurface,
        packetTokens: packetTokens ?? 0,
        packetBudget: packetBudget(cfg),
        surfaceTokens: measurement?.surfaceTokens ?? 0,
        totalTokens: measurement?.totalTokens ?? 0,
        coveredSurfaceNodes: state.coveredSeqs.size,
        lastPacketSeq: state.lastPacket?.seq ?? -1,
      };
    },
  });
}

function expandTool(cfg) {
  return defineTool({
    name: "context_steady_expand",
    description:
      "Re-read the original journal events behind a summarized turn digest ref from the context packet. Returns bounded text; the oldest side is truncated when the span is too large.",
    parameters: {
      ref: {
        type: "string",
        required: true,
        description: "Digest ref from the context packet, e.g. dshcs:digest:3.",
      },
      maxChars: {
        type: "integer",
        description: "Maximum characters to return. Defaults to the plugin-configured cap.",
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      const session = exec.agent?.session;
      if (!session) throw new Error("context_steady_expand requires an agent-owned session");
      const state = stateFor(session, cfg);
      state.sync(session);
      const turn = parseDigestRef(args.ref);
      const digest = turn === undefined ? undefined : state.digestsByTurn.get(turn);
      if (!digest) {
        throw new Error(`unknown context-steady digest ref "${args.ref}" (available: ${state.digests.map((entry) => `${DIGEST_REF_PREFIX}${entry.source.turn}`).join(", ") || "none"})`);
      }
      const fromSeq = digest.source.fromSeq;
      const toSeq = Math.min(digest.source.toSeq, session.events.length - 1);
      const maxChars = clampPositiveInteger(args.maxChars, cfg.toolExpandMaxChars);
      return renderJournalSpan(session, fromSeq, toSeq, maxChars);
    },
  });
}

function parseDigestRef(ref) {
  const raw = String(ref ?? "").trim();
  if (raw.startsWith(DIGEST_REF_PREFIX)) {
    const turn = Number(raw.slice(DIGEST_REF_PREFIX.length));
    return Number.isSafeInteger(turn) && turn >= 0 ? turn : undefined;
  }
  const turn = Number(raw);
  return Number.isSafeInteger(turn) && turn >= 0 ? turn : undefined;
}

function renderJournalSpan(session, fromSeq, toSeq, maxChars) {
  const parts = [];
  for (const event of session.events.slice(fromSeq, toSeq + 1)) {
    let line;
    if (event.type === "user/message") {
      line = `[user] ${messageText(event.data)}`;
    } else if (event.type === "assistant/message") {
      line = `[assistant] ${messageText(event.data.message)}`;
    } else if (event.type === "tool/call") {
      line = `[tool-call] ${event.data.name} ${event.data.arguments}`;
    } else if (event.type === "tool/result") {
      line = `[tool-result] ${event.data.callId ?? ""} ${event.data.error ? `error=${event.data.error.code ?? event.data.error.name}` : "ok"}`;
      const text = messageText(event.data.message);
      if (text) line += `\n${text}`;
    } else if (isSurfaceEvent(event)) {
      const message = deriveEventMessage(event);
      line = `[${event.type}] ${messageText(message)}`;
    } else {
      line = `[${event.type}] ${JSON.stringify(event.data)}`;
    }
    if (line) parts.push(line);
  }
  let output = parts.join("\n");
  if (output.length > maxChars) {
    output = `...[oldest side truncated: ${output.length - maxChars} chars]\n${output.slice(-maxChars)}`;
  }
  return output;
}

class DigestSidecar {
  constructor() {
    this.table = undefined;
    this.domain = undefined;
    this.opening = undefined;
  }

  attach(storageDomain) {
    if (this.domain || this.opening) return this.opening ?? Promise.resolve();
    this.opening = storageDomain.open(digestDomainSpec).then((domain) => {
      this.domain = domain;
      this.table = domain.table("sessions");
    }).finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  close() {
    const domain = this.domain;
    this.domain = undefined;
    this.table = undefined;
    if (!domain) return Promise.resolve();
    return domain.close();
  }

  restore(state) {
    state.sidecarAvailable = Boolean(this.table);
    const row = this.table?.get(String(state.session.id));
    const digests = row?.sessionCreatedAt === state.session.header.createdAt ? row.digests : [];
    state.restoreAuthoritativeDigests(digests);
  }

  async persist(state) {
    if (!this.table) return false;
    const digests = state.digests.filter((digest) => digest.authoritative);
    await this.table.put(String(state.session.id), {
      sessionCreatedAt: state.session.header.createdAt,
      digests,
    });
    state.sidecarAvailable = true;
    state.sidecarLoaded = true;
    state.sidecarDigests = digests.length;
    return true;
  }
}

// ── Plugin wiring ────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config);
  if (!cfg.enabled) return;
  const sidecar = new DigestSidecar();
  const storageFiber = ctx.inject(["storageDomain"], async (storageCtx) => {
    await sidecar.attach(storageCtx.storageDomain);
  });
  ctx.effect(() => () => sidecar.close(), "context-steady.digestSidecarClose");
  void Promise.resolve(storageFiber).catch((error) => {
    ctx.logger?.warn?.(`dsh-context-steady: digest sidecar unavailable: ${error instanceof Error ? error.message : String(error)}`);
  });

  const ensureState = (session) => {
    const state = stateFor(session, cfg);
    state.sync(session);
    if (!state.sidecarLoaded && sidecar.table) sidecar.restore(state);
    if (state.sidecarLoaded && !state.checkpoint) buildCheckpoint(state, cfg, ctx.tokenMeter);
    return state;
  };

  ctx.on("agent/session-start", ({ agent }) => {
    try {
      ensureState(agent.session);
    } catch (error) {
      ctx.logger?.warn?.(`dsh-context-steady: session-start sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ctx.on("session/event", (session) => {
    const state = stateBySession.get(session);
    if (!state) return;
    try {
      state.sync(session);
    } catch (error) {
      ctx.logger?.warn?.(`dsh-context-steady: session/event sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ctx.on("agent/pre-step", async ({ agent, turn, signal }, next) => {
    const decision = await next();
    if (decision.kind !== "enter" || signal.aborted) return decision;
    try {
      const state = ensureState(agent.session);
      let measurement;
      try {
        measurement = ctx.tokenMeter.measure(agent.session);
      } catch {
        measurement = undefined;
      }
      state.ensureActivation(measurement, cfg);
      if (!state.activated || !cfg.packet.enabled) return decision;
      // Packets are normally emitted at turn-stopping so their coverage
      // survives restart. Pre-step is the fallback for a turn that ended
      // without one (e.g. the previous process crashed before emission).
      if (state.lastPacket?.forTurn !== turn) {
        emitPacket(ctx, cfg, agent, state, ctx.tokenMeter, turn);
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-context-steady: packet injection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return decision;
  });

  ctx.on("agent/turn-stopping", async ({ agent, turn, signal }) => {
    try {
      const state = ensureState(agent.session);
      if (!state.activated) return;
      const span = state.turnSpans.get(turn);
      if (span) span.toSeq = Math.max(span.fromSeq, agent.session.events.length - 1);
      const authoritativeDigests = await generateTurnDigests(ctx, cfg, agent, state, turn, signal);
      for (const digest of authoritativeDigests) state.markCoverage(digest, cfg);
      buildCheckpoint(state, cfg, ctx.tokenMeter);
      if (authoritativeDigests.length > 0 && sidecar.table) {
        try {
          await sidecar.persist(state);
        } catch (error) {
          ctx.logger?.warn?.(`dsh-context-steady: digest sidecar write through turn ${turn} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // Durable packet: append it BEFORE turn/end so its content, surfaceOp,
      // and sourceEventSeqs all survive process restart with the session log.
      if (cfg.packet.enabled) {
        emitPacket(ctx, cfg, agent, state, ctx.tokenMeter, turn + 1);
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-context-steady: turn ${turn} digest failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ctx.tools.register(statusTool(cfg, ctx, ensureState));
  ctx.tools.register(expandTool(cfg));
}
