#!/usr/bin/env python3
"""Summarize the dsh-context-steady benchmark results."""

import json, glob, os, re, subprocess
from collections import defaultdict

ZSTD = "/opt/homebrew/bin/zstd"
ROOT = "/tmp/dsh-cs-e2e-home/sessions"
RESULTS = "/tmp/dsh-cs-bench/results.jsonl"

def load_events(path):
    raw = subprocess.check_output([ZSTD, "-dc", path], stderr=subprocess.DEVNULL).decode()
    return [json.loads(line) for line in raw.splitlines() if line.strip()]

def fold_surface(events):
    surface = []
    for e in events:
        op = e.get("surfaceOp")
        if op == "append":
            surface.append(e["seq"])
        elif isinstance(op, dict) and op.get("op") == "replace":
            try:
                start = surface.index(op["start"])
                end = surface.index(op["end"])
                surface[start:end + 1] = [e["seq"]]
            except ValueError:
                pass
    return surface

def prompt_tokens(usage):
    if not usage: return None
    return (usage.get("inputTokens") or 0) + (usage.get("cacheReadTokens") or 0)

sessions = {}
for path in glob.glob(ROOT + "/*/*/session.jsonl.zstd"):
    try:
        events = load_events(path)
        header = events[0]
        cwd = header.get("cwd", "")
        if "/tmp/dsh-cs-bench/" in cwd:
            arm = cwd.split("/tmp/dsh-cs-bench/")[1].strip("/")
            sessions[arm] = path
    except Exception:
        pass

arms_of_interest = [
    "baseline-default-10", "baseline-default-20",
    "plugin-10", "plugin-20",
    "traditional-compact-10-low", "traditional-compact-10",
]

print("## Sessions\n")
for arm, path in sorted(sessions.items()):
    if arm in arms_of_interest:
        ev = load_events(path)
        print(f"- {arm}: {path}  ({len(ev)} events)")

rows = [json.loads(line) for line in open(RESULTS) if line.strip()]
by_arm = defaultdict(list)
for r in rows:
    by_arm[r.get("arm")].append(r)

def main_usage(events):
    total_in = total_out = total_cache_read = total_cache_write = 0
    for e in events:
        if e.get("type") == "assistant/message":
            u = e.get("data", {}).get("usage") or {}
            total_in += u.get("inputTokens") or 0
            total_out += u.get("outputTokens") or 0
            total_cache_read += u.get("cacheReadTokens") or 0
            total_cache_write += u.get("cacheWriteTokens") or 0
    return dict(main_input=total_in, main_output=total_out, main_cache_read=total_cache_read, main_cache_write=total_cache_write)

def compaction_usage(events):
    in_sum = out_sum = 0
    for e in events:
        if e.get("type") == "compaction/summary":
            u = e.get("data", {}).get("usage") or {}
            in_sum += (u.get("inputTokens") or 0) + (u.get("cacheReadTokens") or 0)
            out_sum += u.get("outputTokens") or 0
    return dict(compact_prompt_tokens=in_sum, compact_output_tokens=out_sum, compact_summaries=sum(1 for e in events if e.get("type") == "compaction/summary"))

def parse_digest_usage(lines):
    in_sum = out_sum = 0
    for line in lines:
        m = re.search(r"input=(\d+) output=(\d+)", line)
        if m:
            in_sum += int(m.group(1))
            out_sum += int(m.group(2))
    return dict(digest_input=in_sum, digest_output=out_sum, digest_calls=len(lines))

print("\n## Per-arm turn tables\n")
for arm in arms_of_interest:
    path = sessions.get(arm)
    print(f"\n### {arm}")
    if path:
        ev = load_events(path)
        surface_final = fold_surface(ev)
        mu = main_usage(ev)
        cu = compaction_usage(ev)
        du = parse_digest_usage([x for r in by_arm.get(arm, []) for x in r.get("digest_usage_lines", [])])
        turns = sum(1 for e in ev if e.get("type") == "turn/end")
        print("session totals:", {**mu, **cu, **du, "turns": turns, "final_surface_nodes": len(surface_final), "events": len(ev)})
    print("turn rows:")
    for r in by_arm.get(arm, []):
        turn = r.get("turn")
        if not isinstance(turn, int):
            print(f"  {turn}: stdout={str(r.get('stdout'))[:220]!r} elapsed={r.get('elapsed_s')}")
            continue
        print(
            f"  t={turn:>2} surf={r.get('surface_nodes'):>3} events={r.get('events_total'):>4} "
            f"in={str(r.get('last_input_tokens')):>5} cacheR={str(r.get('last_cache_read')):>6} "
            f"pkt={r.get('packet_events'):>2} cmp={r.get('compaction_summaries'):>2} "
            f"t={r.get('elapsed_s')}s"
        )

print("\n## Checkpoints\n")
for arm in arms_of_interest:
    path = sessions.get(arm)
    if not path: continue
    ev = load_events(path)
    pkt = [e for e in ev if e.get("type") == "user/message" and e.get("data", {}).get("source", {}).get("plugin") == "dsh-context-steady"]
    if pkt:
        text = pkt[-1]["data"]["content"][0]["text"]
        print(f"{arm}: {len(pkt)} packets; last packet {len(text)} chars; checkpoint={'Stable checkpoint:' in text}; digests={'Recent turn digests' in text}")
