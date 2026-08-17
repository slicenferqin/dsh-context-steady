#!/usr/bin/env python3
"""dsh-context-steady 10/20-turn persistent benchmark orchestrator."""

import json, os, subprocess, sys, time, glob

DSH_HOME = "/tmp/dsh-cs-e2e-home"
PROFILE = "cs-e2e"
BENCH_ROOT = "/tmp/dsh-cs-bench"
RESULTS = os.path.join(BENCH_ROOT, "results.jsonl")
DSH = "/opt/homebrew/bin/dsh"
ZSTD = "/opt/homebrew/bin/zstd"

FACTS = [
    "Bounded context keeps provider-bound input independent of raw transcript length.",
    "A turn digest records intent, actions, files, decisions, risks, and next steps.",
    "Stable checkpoints fold older digests into a low-churn long-term layer.",
    "Coverage authorization means only verified digest material may shadow raw spans.",
    "The append-only journal stays intact even after provider payload pruning.",
    "Fallback digests carry continuity but never authorize destructive pruning.",
    "Token budgets are enforced before any packet enters the model-visible surface.",
    "Resume reconstructs ledger state from the durable log without extra storage.",
    "Surface replace shadows raw nodes while citing every covered event sequence.",
    "Context packets keep recent turns in a compact tail instead of replaying them.",
    "Traditional compaction summarizes on pressure thresholds and pays a large summary call.",
    "Context steady prunes every settled turn after an authoritative digest lands.",
    "Long tasks need a bounded working window, not a larger context window.",
    "Auditability requires the raw journal and the derived surface to stay separable.",
    "Recall tools reopen summarized spans from the raw log with bounded output.",
    "A steady-state pipeline is a runtime property, not a prompt template.",
    "Budget arithmetic reserves output headroom before computing packet size.",
    "Checkpoint and packet layers are ordered for KV-cache prefix stability.",
    "Quality gates should fail closed when coverage evidence is incomplete.",
    "Twenty turns should not cost twenty raw transcripts in provider input.",
]


def run(cmd, cwd, env, timeout=240):
    started = time.time()
    proc = subprocess.run(
        cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout,
    )
    return proc.returncode, proc.stdout, proc.stderr, time.time() - started


def find_session_file(session_id):
    paths = glob.glob(os.path.join(DSH_HOME, "sessions", "*", session_id, "session.jsonl.zstd"))
    return paths[0] if paths else None


def fold_surface(events):
    surface = []
    for event in events:
        op = event.get("surfaceOp")
        if op == "append":
            surface.append(event["seq"])
        elif isinstance(op, dict) and op.get("op") == "replace":
            try:
                start = surface.index(op["start"])
                end = surface.index(op["end"])
            except ValueError:
                continue
            surface[start:end + 1] = [event["seq"]]
    return surface


def parse_log(path):
    raw = subprocess.check_output([ZSTD, "-dc", path], stderr=subprocess.DEVNULL).decode()
    events = [json.loads(line) for line in raw.splitlines() if line.strip()]
    surface = fold_surface(events)
    usages = [e["data"].get("usage") for e in events if e.get("type") == "assistant/message" and e["data"].get("usage")]
    last_usage = usages[-1] if usages else {}
    packets = [e for e in events if e.get("type") == "user/message"
               and e.get("data", {}).get("source", {}).get("plugin") == "dsh-context-steady"]
    compact_events = [e for e in events if str(e.get("type", "")).startswith("compaction/")]
    return {
        "events_total": len(events),
        "turns": sum(1 for e in events if e.get("type") == "turn/end"),
        "surface_nodes": len(surface),
        "surface_events_raw": sum(1 for e in events if e.get("surfaceOp")),
        "last_input_tokens": last_usage.get("inputTokens"),
        "last_output_tokens": last_usage.get("outputTokens"),
        "last_cache_read": last_usage.get("cacheReadTokens"),
        "last_cache_write": last_usage.get("cacheWriteTokens"),
        "packet_events": len(packets),
        "last_packet_sources": packets[-1].get("sourceEventSeqs") if packets else None,
        "compaction_events": len(compact_events),
        "compaction_summaries": sum(1 for e in compact_events if e["type"] == "compaction/summary"),
    }


def parse_bench_lines(stderr):
    digest_usage = []
    packet_lines = []
    for line in stderr.splitlines():
        if "[context-steady digest-usage]" in line:
            digest_usage.append(line.strip())
        elif "[context-steady packet]" in line:
            packet_lines.append(line.strip())
    return digest_usage, packet_lines


def task_text(round_no, total):
    fact = FACTS[round_no - 1]
    return (
        f"Round {round_no} of {total} for a benchmark. Append this exact line as a new line "
        f"at the end of facts.md:\nFact{round_no}: {fact}\n"
        f"Then read facts.md and confirm it contains exactly {round_no} lines. "
        f'Reply with only "ok {round_no}".'
    )


def quiz_text(total):
    return (
        f"Without reading facts.md, answer exactly what Fact3 and Fact{total} say in this "
        "session. Quote them verbatim. If you are not sure, say UNKNOWN for that fact."
    )


def run_arm(name, rounds, cs_enabled, compact_ratio=None, quiz=True):
    workdir = os.path.join(BENCH_ROOT, name)
    os.makedirs(workdir, exist_ok=True)
    session_id = None
    arm_results = []
    print(f"== arm {name}: {rounds} rounds, cs={cs_enabled}, compact_ratio={compact_ratio}", flush=True)

    for turn in range(1, rounds + 1):
        env = dict(os.environ)
        env["DSH_HOME"] = DSH_HOME
        env["CONTEXT_STEADY_ENABLED"] = "1" if cs_enabled else "0"
        if compact_ratio is not None:
            env["CONTEXT_STEADY_COMPACT_RATIO"] = str(compact_ratio)
        if cs_enabled:
            env["CONTEXT_STEADY_BENCH"] = "1"
        if session_id:
            env["CONTEXT_STEADY_RESUME"] = session_id
        else:
            env.pop("CONTEXT_STEADY_RESUME", None)

        code, out, err, elapsed = run(
            [DSH, "--profile", PROFILE, task_text(turn, rounds)], workdir, env,
        )
        if code != 0:
            print(f"  turn {turn} FAILED code={code} stderr={err[-500:]}", flush=True)
            arm_results.append({"turn": turn, "error": "run_failed", "stderr": err[-500:]})
            continue

        if session_id is None:
            for line in err.splitlines():
                if "[create] session=" in line:
                    session_id = line.split("session=", 1)[1].strip()
        path = find_session_file(session_id) if session_id else None
        metrics = parse_log(path) if path else {}
        digest_usage, packet_lines = parse_bench_lines(err)
        metrics.update({
            "arm": name,
            "turn": turn,
            "elapsed_s": round(elapsed, 2),
            "stdout": out.strip()[-200:],
            "digest_usage_lines": digest_usage,
            "packet_lines": packet_lines,
        })
        arm_results.append(metrics)
        with open(RESULTS, "a") as fh:
            fh.write(json.dumps(metrics, ensure_ascii=False) + "\n")
        print(
            f"  turn {turn}/{rounds} code={code} t={elapsed:.1f}s "
            f"events={metrics.get('events_total')} surface={metrics.get('surface_nodes')} "
            f"input={metrics.get('last_input_tokens')} packet={metrics.get('packet_events')} "
            f"compact={metrics.get('compaction_summaries')}",
            flush=True,
        )

    if quiz and session_id:
        env = dict(os.environ)
        env["DSH_HOME"] = DSH_HOME
        env["CONTEXT_STEADY_ENABLED"] = "1" if cs_enabled else "0"
        if compact_ratio is not None:
            env["CONTEXT_STEADY_COMPACT_RATIO"] = str(compact_ratio)
        if cs_enabled:
            env["CONTEXT_STEADY_BENCH"] = "1"
        env["CONTEXT_STEADY_RESUME"] = session_id
        code, out, err, elapsed = run([DSH, "--profile", PROFILE, quiz_text(rounds)], workdir, env)
        path = find_session_file(session_id)
        metrics = parse_log(path) if path else {}
        metrics.update({
            "arm": name, "turn": f"quiz-{rounds}", "elapsed_s": round(elapsed, 2),
            "stdout": out.strip()[-500:], "stderr_tail": err.strip()[-500:],
        })
        with open(RESULTS, "a") as fh:
            fh.write(json.dumps(metrics, ensure_ascii=False) + "\n")
        print(f"  quiz {rounds} code={code} answer={out.strip()[-180:]}", flush=True)

    return arm_results


def main():
    os.makedirs(BENCH_ROOT, exist_ok=True)
    with open(RESULTS, "w") as fh:
        fh.write("")
    # Baseline: DSH traditional compaction at its default threshold (likely
    # dormant at this size) — this is the "插件不开" reference.
    run_arm("baseline-default-10", 10, cs_enabled=False)
    run_arm("baseline-default-20", 20, cs_enabled=False)
    # Plugin: context-steady enabled with opencode-go/deepseek-v4-flash digest.
    run_arm("plugin-10", 10, cs_enabled=True)
    run_arm("plugin-20", 20, cs_enabled=True)
    # Traditional compaction forced early for a qualitative 10-turn comparison.
    run_arm("traditional-compact-10", 10, cs_enabled=False, compact_ratio=0.05)
    print("DONE", flush=True)


if __name__ == "__main__":
    main()
