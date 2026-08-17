#!/usr/bin/env python3
"""Run a decision-grade user-value comparison for dsh-context-steady.

The benchmark models a real long-running coding session: each turn records a
unique implementation decision plus a large, irrelevant tool transcript. The
final fresh-process probe asks for decisions distributed across the session.
The baseline must retain raw history; context-steady must answer from its
bounded packet while preserving exact raw-journal expansion.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

DEFAULT_DSH_HOME = Path("/tmp/dsh-cs-e2e-home")
DEFAULT_PROFILE = "cs-e2e"
DEFAULT_ROOT = Path("/tmp/dsh-cs-value")
DEFAULT_DSH = shutil.which("dsh") or "/opt/homebrew/bin/dsh"
DEFAULT_ZSTD = shutil.which("zstd") or "/opt/homebrew/bin/zstd"

DECISION_RE = re.compile(r"DECISION-(\d{2})=([A-Z0-9-]+)")
CREATE_RE = re.compile(r"\[create\] session=(\S+)")
DIGEST_USAGE_RE = re.compile(r"input=(\d+) output=(\d+)(?: cacheRead=(\d+))?(?: cacheWrite=(\d+))?")


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--rounds", type=int, default=8)
    parser.add_argument("--payload-chars", type=int, default=22000)
    parser.add_argument("--repetitions", type=int, default=1)
    parser.add_argument("--activation", type=int, default=0)
    parser.add_argument("--dsh-home", type=Path, default=DEFAULT_DSH_HOME)
    parser.add_argument("--profile", default=DEFAULT_PROFILE)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--dsh", default=DEFAULT_DSH)
    parser.add_argument("--zstd", default=DEFAULT_ZSTD)
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--min-provider-token-reduction", type=float, default=0.0)
    parser.add_argument("--max-cost-change", type=float)
    parser.add_argument("--max-latency-change", type=float)
    return parser.parse_args()


def run_process(command, cwd, env, timeout):
    started = time.monotonic()
    try:
        proc = subprocess.run(
            command,
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return {
            "code": proc.returncode,
            "stdout": proc.stdout.strip(),
            "stderr": proc.stderr.strip(),
            "elapsed_s": round(time.monotonic() - started, 3),
        }
    except subprocess.TimeoutExpired as error:
        return {
            "code": 124,
            "stdout": (error.stdout or "").strip(),
            "stderr": (error.stderr or "").strip(),
            "elapsed_s": round(time.monotonic() - started, 3),
            "timeout": True,
        }


def find_session_file(dsh_home, session_id):
    matches = list((dsh_home / "sessions").glob(f"*/{session_id}/session.jsonl.zstd"))
    if len(matches) != 1:
        raise RuntimeError(f"expected exactly one session file for {session_id}, found {len(matches)}")
    return matches[0]


def load_events(path, zstd):
    proc = subprocess.run([zstd, "-dc", str(path)], capture_output=True, check=True)
    return [json.loads(line) for line in proc.stdout.decode().splitlines() if line.strip()]


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
            surface[start : end + 1] = [event["seq"]]
    return surface


def usage_totals(events):
    totals = {"main_miss": 0, "main_hit": 0, "main_out": 0}
    for event in events:
        if event.get("type") != "assistant/message":
            continue
        usage = event.get("data", {}).get("usage") or {}
        totals["main_miss"] += usage.get("inputTokens") or 0
        totals["main_hit"] += usage.get("cacheReadTokens") or 0
        totals["main_out"] += usage.get("outputTokens") or 0
    return totals


def digest_usage(stderr):
    totals = {"digest_miss": 0, "digest_hit": 0, "digest_out": 0, "digest_calls": 0}
    for line in stderr.splitlines():
        if "[context-steady digest-usage]" not in line:
            continue
        match = DIGEST_USAGE_RE.search(line)
        if not match:
            continue
        totals["digest_miss"] += int(match.group(1))
        totals["digest_out"] += int(match.group(2))
        totals["digest_hit"] += int(match.group(3) or 0)
        totals["digest_calls"] += 1
    return totals


def merge_usage(total, delta):
    for key, value in delta.items():
        total[key] = total.get(key, 0) + value


def token_cost_cny(usage):
    return (
        (usage.get("main_miss", 0) + usage.get("digest_miss", 0)) * 3.0
        + (usage.get("main_hit", 0) + usage.get("digest_hit", 0)) * 0.10
        + (usage.get("main_out", 0) + usage.get("digest_out", 0)) * 9.0
    ) / 1_000_000

def provider_tokens(usage):
    return sum(
        usage.get(key, 0)
        for key in ("main_miss", "main_hit", "main_out", "digest_miss", "digest_hit", "digest_out")
    )


def expected_decisions(rounds):
    return {turn: f"ARCH-{turn:02}-LOCKED" for turn in range(1, rounds + 1)}


def payload_text(turn, size):
    header = f"TOOL-TRACE-{turn:02}|"
    unit = f"noise-{turn:02}-abcdefghijklmnopqrstuvwxyz0123456789|"
    return (header + unit * ((size // len(unit)) + 1))[:size]


def work_prompt(turn, rounds, payload):
    decision = f"DECISION-{turn:02}=ARCH-{turn:02}-LOCKED"
    return (
        f"Coding-session checkpoint {turn} of {rounds}. Record the exact architecture decision "
        f"{decision}. The following tool transcript is evidence from this turn but contains no "
        f"additional decisions:\n<tool-transcript>\n{payload}\n</tool-transcript>\n"
        f"Reply with exactly ACK-{turn:02}. Do not repeat the transcript."
    )


def probe_turns(rounds):
    turns = {1, rounds, max(1, (rounds + 1) // 2)}
    if rounds >= 4:
        turns.add(rounds // 3 or 1)
    return sorted(turns)


def probe_prompt(rounds):
    turns = probe_turns(rounds)
    requested = ", ".join(f"DECISION-{turn:02}" for turn in turns)
    return (
        f"Without using tools, return the exact values of {requested}. Output one line per item "
        "as DECISION-NN=value and no other text. Use UNKNOWN when the session does not establish "
        "a value."
    )


def parse_answer(text):
    parsed = {}
    for match in DECISION_RE.finditer(text):
        parsed[int(match.group(1))] = match.group(2)
    return parsed


def score_answer(text, expected, turns):
    parsed = parse_answer(text)
    correct = sum(parsed.get(turn) == expected[turn] for turn in turns)
    return {
        "correct": correct,
        "total": len(turns),
        "score": round(correct / len(turns), 4),
        "parsed": {str(turn): parsed.get(turn) for turn in turns},
    }


def exact_expand_prompt(turn):
    return (
        f"Call context_steady_expand with ref dshcs:digest:{turn} and maxChars 4000. "
        f"From its output return only the exact DECISION-{turn:02}=... marker."
    )


def run_arm(args, arm, repetition):
    enabled = arm == "plugin"
    workdir = args.root / f"{arm}-r{repetition}"
    if workdir.exists():
        shutil.rmtree(workdir)
    workdir.mkdir(parents=True)
    session_id = None
    runs = []
    side_usage = {}
    expected = expected_decisions(args.rounds)

    for turn in range(1, args.rounds + 1):
        env = dict(os.environ)
        env["DSH_HOME"] = str(args.dsh_home)
        env["CONTEXT_STEADY_ENABLED"] = "1" if enabled else "0"
        env["CONTEXT_STEADY_ACTIVATION"] = str(args.activation)
        env["CONTEXT_STEADY_BENCH"] = "1"
        if session_id:
            env["CONTEXT_STEADY_RESUME"] = session_id
        else:
            env.pop("CONTEXT_STEADY_RESUME", None)
        result = run_process(
            [args.dsh, "--profile", args.profile, work_prompt(turn, args.rounds, payload_text(turn, args.payload_chars))],
            workdir,
            env,
            args.timeout,
        )
        result.update({"kind": "work", "turn": turn})
        runs.append(result)
        merge_usage(side_usage, digest_usage(result["stderr"]))
        if result["code"] != 0:
            raise RuntimeError(f"{arm} repetition {repetition} turn {turn} failed: {result['stderr'][-1000:]}")
        if session_id is None:
            match = CREATE_RE.search(result["stderr"])
            if not match:
                raise RuntimeError(f"{arm} repetition {repetition}: create line missing")
            session_id = match.group(1)

    env = dict(os.environ)
    env["DSH_HOME"] = str(args.dsh_home)
    env["CONTEXT_STEADY_ENABLED"] = "1" if enabled else "0"
    env["CONTEXT_STEADY_ACTIVATION"] = str(args.activation)
    env["CONTEXT_STEADY_BENCH"] = "1"
    env["CONTEXT_STEADY_RESUME"] = session_id
    probe = run_process(
        [args.dsh, "--profile", args.profile, probe_prompt(args.rounds)],
        workdir,
        env,
        args.timeout,
    )
    probe.update({"kind": "probe"})
    runs.append(probe)
    merge_usage(side_usage, digest_usage(probe["stderr"]))
    if probe["code"] != 0:
        raise RuntimeError(f"{arm} repetition {repetition} probe failed: {probe['stderr'][-1000:]}")
    core_elapsed = sum(run["elapsed_s"] for run in runs)
    core_session_path = find_session_file(args.dsh_home, session_id)
    core_events = load_events(core_session_path, args.zstd)
    core_surface = fold_surface(core_events)
    core_usage = usage_totals(core_events)
    merge_usage(core_usage, side_usage)
    core_packets = [
        event for event in core_events
        if event.get("type") == "user/message"
        and event.get("data", {}).get("source", {}).get("plugin") == "dsh-context-steady"
    ]

    expansion = None
    if enabled:
        expand_turn = 1
        expansion = run_process(
            [args.dsh, "--profile", args.profile, exact_expand_prompt(expand_turn)],
            workdir,
            env,
            args.timeout,
        )
        expansion.update({"kind": "expand", "turn": expand_turn})
        runs.append(expansion)
        merge_usage(side_usage, digest_usage(expansion["stderr"]))
        expansion["exact"] = f"DECISION-{expand_turn:02}={expected[expand_turn]}" in expansion["stdout"]

    session_path = find_session_file(args.dsh_home, session_id)
    events = load_events(session_path, args.zstd)
    raw_markers = {
        turn: any(
            f"DECISION-{turn:02}={expected[turn]}" in json.dumps(event, ensure_ascii=False)
            for event in events
        )
        for turn in expected
    }
    score = score_answer(probe["stdout"], expected, probe_turns(args.rounds))
    elapsed = sum(run["elapsed_s"] for run in runs)
    return {
        "arm": arm,
        "repetition": repetition,
        "session_id": session_id,
        "rounds": args.rounds,
        "payload_chars": args.payload_chars,
        "activation": args.activation,
        "probe_turns": probe_turns(args.rounds),
        "probe_answer": probe["stdout"],
        "quality": score,
        "expand_exact": expansion["exact"] if expansion else None,
        "all_raw_markers_retained": all(raw_markers.values()),
        "surface_nodes": len(core_surface),
        "packet_events": len(core_packets),
        "journal_events": len(core_events),
        "core_elapsed_s": round(core_elapsed, 3),
        "elapsed_s": round(elapsed, 3),
        "usage": core_usage,
        "provider_tokens": provider_tokens(core_usage),
        "estimated_peak_cny": round(token_cost_cny(core_usage), 6),
        "runs": runs,
    }


def summarize(results):
    arms = {}
    for arm in ("baseline", "plugin"):
        rows = [row for row in results if row["arm"] == arm]
        arms[arm] = {
            "runs": len(rows),
            "quality_passes": sum(row["quality"]["score"] == 1 for row in rows),
            "quality_mean": round(sum(row["quality"]["score"] for row in rows) / len(rows), 4),
            "mean_surface_nodes": round(sum(row["surface_nodes"] for row in rows) / len(rows), 2),
            "mean_elapsed_s": round(sum(row["core_elapsed_s"] for row in rows) / len(rows), 3),
            "mean_provider_tokens": round(sum(row["provider_tokens"] for row in rows) / len(rows), 2),
            "mean_peak_cny": round(sum(row["estimated_peak_cny"] for row in rows) / len(rows), 6),
            "raw_retention_passes": sum(row["all_raw_markers_retained"] for row in rows),
            "expand_passes": sum(row["expand_exact"] is True for row in rows),
        }
    baseline = arms["baseline"]
    plugin = arms["plugin"]
    plugin["surface_reduction_pct"] = round(
        (1 - plugin["mean_surface_nodes"] / baseline["mean_surface_nodes"]) * 100,
        2,
    )
    plugin["provider_token_reduction_pct"] = round(
        (1 - plugin["mean_provider_tokens"] / baseline["mean_provider_tokens"]) * 100,
        2,
    )
    plugin["cost_change_pct"] = round(
        (plugin["mean_peak_cny"] / baseline["mean_peak_cny"] - 1) * 100,
        2,
    )
    plugin["latency_change_pct"] = round(
        (plugin["mean_elapsed_s"] / baseline["mean_elapsed_s"] - 1) * 100,
        2,
    )
    return arms

def gate_failures(summary, args):
    plugin = summary["plugin"]
    failures = []
    if summary["baseline"]["quality_passes"] != args.repetitions:
        failures.append("baseline decision recall did not pass every repetition")
    if plugin["quality_passes"] != args.repetitions:
        failures.append("plugin decision recall did not pass every repetition")
    if plugin["raw_retention_passes"] != args.repetitions:
        failures.append("plugin raw-journal retention did not pass every repetition")
    if plugin["expand_passes"] != args.repetitions:
        failures.append("plugin exact expansion did not pass every repetition")
    if plugin["provider_token_reduction_pct"] < args.min_provider_token_reduction:
        failures.append(
            f"provider token reduction {plugin['provider_token_reduction_pct']}% is below "
            f"{args.min_provider_token_reduction}%"
        )
    if args.max_cost_change is not None and plugin["cost_change_pct"] > args.max_cost_change:
        failures.append(
            f"cost change {plugin['cost_change_pct']}% exceeds {args.max_cost_change}%"
        )
    if args.max_latency_change is not None and plugin["latency_change_pct"] > args.max_latency_change:
        failures.append(
            f"latency change {plugin['latency_change_pct']}% exceeds {args.max_latency_change}%"
        )
    return failures


def print_summary(summary):
    print("arm       quality  surface  tokens    time(s)  est. peak CNY  raw  expand")
    for arm in ("baseline", "plugin"):
        row = summary[arm]
        print(
            f"{arm:<10}{row['quality_passes']}/{row['runs']:<7}"
            f"{row['mean_surface_nodes']:<9}{row['mean_provider_tokens']:<10}"
            f"{row['mean_elapsed_s']:<9}"
            f"{row['mean_peak_cny']:<15}{row['raw_retention_passes']}/{row['runs']:<4}"
            f"{row['expand_passes']}/{row['runs'] if arm == 'plugin' else '-'}"
        )
    print(
        f"plugin deltas: surface {summary['plugin']['surface_reduction_pct']}%, "
        f"provider tokens -{summary['plugin']['provider_token_reduction_pct']}%, "
        f"cost {summary['plugin']['cost_change_pct']}%, "
        f"latency {summary['plugin']['latency_change_pct']}%"
    )


def main():
    args = parse_args()
    if args.rounds < 3:
        raise SystemExit("--rounds must be at least 3")
    if args.payload_chars < 1000:
        raise SystemExit("--payload-chars must be at least 1000")
    args.root.mkdir(parents=True, exist_ok=True)
    results = []
    for repetition in range(1, args.repetitions + 1):
        for arm in ("baseline", "plugin"):
            print(f"running {arm} repetition {repetition}/{args.repetitions}", flush=True)
            result = run_arm(args, arm, repetition)
            results.append(result)
            print(
                f"  quality={result['quality']['correct']}/{result['quality']['total']} "
                f"surface={result['surface_nodes']} cost={result['estimated_peak_cny']} "
                f"time={result['elapsed_s']}s",
                flush=True,
            )
    summary = summarize(results)
    artifact = {
        "schemaVersion": 1,
        "config": {
            "rounds": args.rounds,
            "payload_chars": args.payload_chars,
            "repetitions": args.repetitions,
            "activation": args.activation,
            "dsh_home": str(args.dsh_home),
            "profile": args.profile,
        },
        "results": results,
        "summary": summary,
    }
    output = args.root / "value-results.json"
    output.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n")
    print_summary(summary)
    print(f"artifact: {output}")
    failures = gate_failures(summary, args)
    if failures:
        for failure in failures:
            print(f"release gate failed: {failure}", file=sys.stderr)
        raise SystemExit(2)
    print("release gates passed")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(f"value benchmark failed: {error}", file=sys.stderr)
        raise SystemExit(1)
