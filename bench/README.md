# Benchmark harness

These are the exact files used for the persistent 10/20-turn benchmark in
[`BENCHMARK.md`](../BENCHMARK.md). They assume an installed `dsh`
(`0.1.0-rc.6`) and a profile whose bundle order is
`@deepseek-ai/dsh-base` → `@deepseek-ai/dsh-headless` → `dsh-context-steady`.

1. Create an isolated `DSH_HOME` and a profile (copy your
   `settings.yaml` / `.credentials.yaml` into it first):

   ```sh
   DSH_HOME=/tmp/dsh-cs-e2e-home dsh plugin --profile cs-e2e add /path/to/dsh-context-steady
   ```

2. Make the profile headless-capable and togglable. Its
   `cordis.patch.yml` should:

   - disable the shipped `headless-runner` and insert `./e2e-runner.mjs`
     (`task: !!js ctx.headlessStartup.task`,
     `resumeSessionId: !!js process.env.CONTEXT_STEADY_RESUME || ''`);
   - set `context-steady.enabled` from
     `!!js process.env.CONTEXT_STEADY_ENABLED !== '0'`, with
     `activationThresholdTokens: 0` and `digest.llm` pointing at your route;
   - optionally set `compaction-basic.thresholdRatio` from
     `CONTEXT_STEADY_COMPACT_RATIO`.

3. Run:

   ```sh
   python3 run_bench.py
   python3 analyze_bench.py
   ```

`run_bench.py` writes one JSON line per turn to
`/tmp/dsh-cs-bench/results.jsonl`. `analyze_bench.py` folds every persisted
session surface and prints the cost/growth tables.

## User-value comparison

`run_value_bench.py` tests the claim a user actually depends on: after a
long-running coding session full of large tool transcripts, can a fresh
process recall decisions from early, middle, and recent turns while sending a
bounded surface and retaining exact raw evidence?

It runs baseline and forced-activation plugin arms against the same profile,
scores exact decision recall, folds the persisted surface, accounts for all
main and digest usage, and verifies `context_steady_expand` against turn 1.

```sh
python3 run_value_bench.py \
  --rounds 8 \
  --payload-chars 22000 \
  --repetitions 3 \
  --min-provider-token-reduction 10
```

The default output artifact is
`/tmp/dsh-cs-value/value-results.json`. Use at least three repetitions before
making a release claim; a single run demonstrates the path but does not
establish statistical reliability. `--activation 0` intentionally exercises
the mechanism rather than the plugin's protective 500K default threshold.

The runner exits non-zero unless both arms pass exact decision recall in every
repetition and the plugin passes raw-journal retention plus exact expansion in
every repetition. `--min-provider-token-reduction` adds a quantitative release
floor. Optional `--max-cost-change` and `--max-latency-change` gates let a
release owner enforce stricter promises; omitting them reports cost/latency
without pretending they are universal pass/fail thresholds.

The profile must expose the cadence used by the package defaults:

```yaml
digest:
  everyTurns: !!js Number(process.env.CONTEXT_STEADY_DIGEST_EVERY || 4)
  llm:
    maxTokens: !!js Number(process.env.CONTEXT_STEADY_DIGEST_MAX_TOKENS || 768)
```

The benchmark artifact records every raw subprocess result and aggregate
usage at `<root>/value-results.json`; do not publish aggregate claims without
retaining that file.
