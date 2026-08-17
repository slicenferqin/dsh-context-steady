# dsh-context-steady

A DeepSeek Harness plugin that transplants the core of San v0.1
**Context Steady** onto DSH's public seams, without modifying the agent loop.

San's claim is about a runtime property, not a prompt template: provider-bound
context must stop growing linearly with the raw transcript, while continuity
and auditability survive. This plugin reproduces that property with DSH's own
`Session` log + ordered surface.

- **TurnDigest ledger** — every settled turn becomes a structured digest
  (intent / actions / decisions / files / tool evidence / risks / next steps).
- **Stable checkpoint** — older digests roll up into one budget-bounded,
  stable layer.
- **Bounded ContextPacket** — at turn settle (before `turn/end`), a snapshot
  user message carries checkpoint + recent digest tail under an explicit token
  budget; it is durable in the session log and therefore survives resume.
- **Provider payload pruning** — when a span is covered by *authoritative*
  digests, the new packet replaces the old packet **and** the covered raw span
  in a single surface `replace`. The append-only event log keeps the raw span;
  only the provider-bound derived history shrinks.
- **Durable authoritative digest sidecar** — when DSH's optional
  `ctx.storageDomain` service is mounted, successful LLM digests are stored
  outside the session log and restored on resume. Without storage, replay
  remains deterministic and fail-closed.
- **`context_steady_expand`** — re-reads the raw journal span behind a digest
  ref (bounded, oldest side truncated).
- **`context_steady_status`** — model-facing audit of the ledger, checkpoint,
  packet budget, and pruning coverage.

Optional LLM digestion uses one side `ctx.llm.stream` request per configured
batch (four settled turns by default) with deterministic fallbacks; the main
loop has no hard dependency on it.

## Why DSH is a good fit

| San mechanism | DSH mechanism used here |
| --- | --- |
| `san.turn_digest` CustomEntry | in-memory ledger rebuilt from `session.events`; authoritative LLM digests optionally persisted through `ctx.storageDomain` |
| `san.context_checkpoint` | deterministic fold over older digests, budgeted by `ctx.tokenMeter` |
| `san.context_packet` injection | `user/message` with `source: {kind:'plugin', plugin:'dsh-context-steady', form:'snapshot'}` |
| provider payload pruning (`prune.ts`) | one `surfaceOp: {op:'replace', start, end}` shadowing `[old packet … covered raw]` |
| append-only journal / audit | DSH session log (replacements shadow surface only, log is untouched) |
| `context_expand` | `context_steady_expand` tool reading `session.events[fromSeq..toSeq]` |
| budget / reserve ratio | `ctx.tokenMeter.measure` + `estimateMessage`, San's formulas |
| optional LLM digest | batched `ctx.llm.stream` + JSON recovery + deterministic fallback |

One important difference: DSH third-party plugins cannot currently add new
required session event types safely (the known-event-type whitelist is built
into the harness). The digest ledger is therefore **derived state, not a new
session event type**. Deterministic fallback digests always rebuild from the
raw log. When the host exposes `ctx.storageDomain` (the standard web bundle
does), authoritative LLM digests also survive restart in the
`dsh_context_steady` sidecar domain; hosts without storage keep the original
deterministic replay behavior.

## Install

Requires Node.js 22+ and DeepSeek Harness 0.1.0-rc.6.
The package declares Harness service libraries as peers; `dsh plugin add`
resolves them from the profile's `@deepseek-ai/dsh-base` bundle rather than
installing duplicate runtime copies.

Install the published package:

```sh
dsh plugin --profile demo add dsh-context-steady
dsh --profile demo --dump-config   # expect a "# == dsh-context-steady" layer
```

To test a source checkout before publishing:

```sh
dsh plugin --profile demo add ./dsh-context-steady
```

Or manually append the bundle patch to a profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: context-steady
      name: 'dsh-context-steady'
      config: {}
```

## Configuration

All fields are optional and defaulted by the loader schema.

```yaml
- id: context-steady
  name: 'dsh-context-steady'
  config:
    enabled: true
    activationThresholdTokens: 500000     # 0 = activate immediately; sticky once crossed
    qualityWindowTokens: 240000
    reserveRatio: 0.25

    digest:
      enabled: true
      everyTurns: 4                       # one side request covers up to four settled turns
      llm:
        enabled: false                    # enable to upgrade digests + authorize raw pruning
        provider: ""                      # empty = reuse the session's routed provider/model
        model: ""
        maxTokens: 768                    # budget for the whole batch response
        timeoutMs: 20000
        maxTranscriptChars: 12000         # budget shared by the batched turn payload

    checkpoint:
      enabled: true
      everyTurns: 6
      maxTokens: 12000

    packet:
      enabled: true
      recentDigests: 5
      maxTokens: 3000                     # packet layer budget

    prune:
      enabled: true
      requireAuthoritativeDigest: true    # San's fail-closed default: deterministic digests never authorize raw pruning

    toolExpandMaxChars: 8000
```

Packet budget follows San's legacy formula:
`min(packet.maxTokens, max(0, qualityWindowTokens * (1 - reserveRatio)))`.

## Behavior contract

1. **Before activation** the plugin is native-equivalent: it only measures.
   Activation is sticky per session and also restored on resume when a packet
   event is already present in the log.
2. **After activation**, every settled turn produces a digest. The deterministic
   fallback is pure structure/regex extraction and never throws.
   When LLM digestion is enabled, fallbacks are upgraded in batches at
   `digest.everyTurns`; only those authoritative upgrades authorize pruning.
3. **Coverage is fail-closed.** With `requireAuthoritativeDigest: true` (the
   default, matching San), only a successful LLM digest marks a turn
   authoritative and allows its raw surface span to be shadowed. Fallback
   digests still flow into the packet as continuity, but they never delete raw
   provider-bound history. Set the flag to `false` only for experiments.
4. **The log is never mutated.** Every packet is an append; pruning is a surface
   `replace` whose `sourceEventSeqs` cite every shadowed node. UI/transcript
   consumers read append-origin events; the replacement copy is model-only.
5. **The packet is durable, not a pre-step side effect.** It is appended at
   `agent/turn-stopping`, *before* `turn/end`, so its content, `surfaceOp`,
   and `sourceEventSeqs` coverage survive process restarts with the session
   log. `agent/pre-step` only fills in if a turn ended without one (for
   example a crash before emission). If compaction runs in the same
   waterfall, the packet is already on the surface and the compaction
   transaction simply sees it.
6. **Digest sidecar is optional.** The plugin does not require storage to
   activate. With `ctx.storageDomain`, authoritative digest content survives
   restart; without it, packet/coverage stay durable in the session log and
   historical digest content rebuilds as deterministic fallback.
7. **Batch failures stay fail-closed.** Invalid JSON, timeout, model-routing
   failure, or a result-count mismatch keeps every turn's deterministic
   fallback and leaves its raw surface nodes provider-visible. The next cadence
   boundary retries the pending batch.

## Tools

- `context_steady_status()` — ledger size, authoritative digest count,
  sidecar availability/restored count, checkpoint coverage, packet
  presence/tokens, surface/request token estimate, covered-node count.
- `context_steady_expand(ref, maxChars?)` — expands `[ref: dshcs:digest:N]`
  from the packet into the raw journal span. Output is bounded; the oldest
  side is truncated.

## Verification

See **[BENCHMARK.md](./BENCHMARK.md)** for the persistent baseline comparison,
cost breakdown, release gates, and honest limitations.

Observed release gate (`8 × 22K`-character synthetic coding turns, 3
repetitions, forced activation): exact cross-turn recall passed 3/3 for both
arms; plugin raw retention and turn-1 expansion passed 3/3; mean provider
tokens fell 51.63% and mean surface nodes fell 63.90%. Estimated peak-price
cost rose 114.86%, so this is not advertised as a cost-saving plugin. See the
report for workload, pricing assumptions, variance, and raw artifact path.

```sh
npm test
npm run test:release
```

The smoke suite runs against real `Session`/surface machinery with a mocked
context and asserts:

- loader contract and schema defaults;
- deterministic digest ledger + fail-closed append packet;
- `context_steady_expand` raw-span recall;
- LLM digest authorizes packet replacement and raw-surface pruning while the
  append-only log retains the raw span;
- a process-restart replay (fresh `Session` seeded from the durable log)
  reconstructs packet presence and coverage from `surfaceOp` +
  `sourceEventSeqs` alone;
- batched LLM digests at the configured cadence, including fenced JSON-array
  recovery;
- subsequent fallback turns replace only the previous packet;
- checkpoint rollup and stable→recent packet layer ordering;
- optional storage-domain persistence restores authoritative LLM digest
  content and count after a fresh `Session` replay.

A live profile check can be done with:

```sh
DSH_HOME=/tmp/dsh-context-steady-home \
  dsh plugin --profile cs add /path/to/dsh-context-steady
DSH_HOME=/tmp/dsh-context-steady-home dsh --profile cs --dump-config
```

### Real persistent E2E (headless + resume, `opencode-go/deepseek-v4-flash`)

A four-turn persistent run was driven through `dsh-base + dsh-headless +
dsh-context-steady` with `activationThresholdTokens: 0` (forced activation for
the mechanism test) and LLM digest enabled.
Each turn ran in a separate process: run 1 created the session, runs 2–4
resumed it via `ctx.agents.resume`. The persisted `session.jsonl.zstd` shows:

- raw log grew to **215 events** (26 surface-producing), all retained;
- every `turn/end` boundary was preceded by one packet `replace` whose
  `sourceEventSeqs` cite the covered raw nodes;
- after 4 turns the derived surface is exactly **4 nodes**
  (`initial runtime context` + `latest packet`), while `surfaceTokens`
  held at ~3k and packet at ~480/3000 tokens;
- `context_steady_expand` recovered the original turn-1 prompt verbatim from
  the journal after pruning.

This is the DSH equivalent of San's acceptance shape: provider-bound context
stops growing with the raw transcript while the raw log stays append-only.

## Known limitations and deferred work

- **Authoritative digest persistence is optional, not universal.** Standard
  DSH web profiles mount `ctx.storageDomain`, so successful LLM digest content
  is restored across process restarts. Minimal/headless profiles without that
  service still retain packet content and pruning coverage in the session log,
  but historical digests rebuild as deterministic fallback.
- **LLM digest runs at `agent/turn-stopping`.** DSH has no post-turn async hook
  that is awaited before the next prompt. The plugin therefore batches four
  settled turns by default and pays one synchronous side request at each
  cadence boundary (bounded by `digest.llm.timeoutMs`). This keeps the next
  packet race-free while avoiding one side request per turn.
- **A batch can remain fallback.** In the final three-repetition gate, one of
  six side batches did not upgrade to authoritative. The fail-closed contract
  held: raw evidence remained visible and every quality/expand gate passed.
  Monitor `context_steady_status.authoritativeDigests` when bounded-surface
  behavior is an operational requirement.
- **No recall layer.** San's `retrieved_context` layer depends on San Brain and
  a memory backend; DSH has no equivalent seam yet. The packet template and
  budget code already reserve the layer slot for a future DSH memory backend.
- **No quality-gate burst mode / emergency stub.** The first DSH port keeps the
  steady-state path only; San's burst/hard-pressure and tool-stub degradation
  need a DSH pressure event (e.g. `agent/request-error` context overflow) and
  are deferred.
- **Deterministic digest quality is deliberately conservative.** It extracts
  files/tool evidence from structured tool events and patterns from assistant
  text; enable `digest.llm` for richer digests and pruning authorization.
