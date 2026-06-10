#!/usr/bin/env python3
"""
predict_replay.py — Feed linguist JSONL prompts to /api/admin/diag/classify-full
and compare returned baselines to ground-truth label.

Purpose:
  Item #1 audit Follow-up + Item #3 L1 improvement evidence. Gives per-rule,
  per-lang, per-turn-count accuracy WITHOUT needing thin live traffic and
  WITHOUT incurring LLM cost (diag endpoint runs L1+L2+floor, no LLM call).

Endpoint migrated 2026-06-10 per ADR `2026-06-10_classify-endpoint-honest-routing`:
  /api/classify now returns real-routing cx (post-L2, post-floor) for honesty.
  Offline L1-rule evaluation needs the L1-only baseline, which lives at
  /api/admin/diag/classify-full (returns all three baselines in one call).

Usage:
  cd c:/casca/casca-minilm
  export CASCA_ADMIN_SECRET=...                            # required for admin endpoint
  python jobs/predict_replay.py                            # full replay (~30 min @ concurrency 4)
  python jobs/predict_replay.py --limit 100                # smoke test
  python jobs/predict_replay.py --file data/en_L12_batch_2.jsonl # one file
  python jobs/predict_replay.py --api http://localhost:3001/api/admin/diag/classify-full
  python jobs/predict_replay.py --concurrency 8            # faster, polite
  python jobs/predict_replay.py --baseline l1_plus_l2_plus_floor  # default: l1_only

Output: data/reports/PREDICT_REPLAY_<date>.md
        + data/reports/PREDICT_REPLAY_<date>.csv  (raw per-row results)

Notes:
  - Diag endpoint returns {l1, dyn_conf, l2, serving_layer_floor, final_cx_baselines}.
    Default --baseline=l1_only matches the original semantic of this job.
  - Multi-turn rows (turn_count>1) are still evaluated single-turn (no lastTier passed);
    flag `turn_count` in report so analysis can exclude them when needed.
  - L2 invoke rate computed from `dyn_conf.triggers_l2` field.
  - Uses stdlib only (no requirements.txt change).
"""

import argparse
import collections
import concurrent.futures
import csv
import datetime
import glob
import json
import os
import sys
import time
import urllib.request
import urllib.error

DEFAULT_API = "https://api.cascaio.com/api/admin/diag/classify-full"
ACCEPTED_LABELS = {"HIGH", "MED", "LOW"}
LABEL_NORMALIZE = {"HIGH": "HIGH", "MED": "MED", "LOW": "LOW", "AMBIG": "MED"}
# Which baseline to evaluate against ground truth.
# Default `l1_only` matches the historical semantic of this job (L1-rule audit).
# Use `l1_plus_l2_plus_floor` to evaluate the serving-path cx.
VALID_BASELINES = {"l1_only", "l1_plus_l2", "l1_plus_l2_plus_floor"}


def discover_files(directory):
    """Find canonical training JSONL files; skip .bak files and reports."""
    patterns = [
        "*_L12_batch_*.jsonl",
        "*_master_*.jsonl",
        "*_edge_cases_*.jsonl",
        "phase2_*.jsonl",
    ]
    files = set()
    for pat in patterns:
        for f in glob.glob(os.path.join(directory, pat)):
            if f.endswith(".bak"):
                continue
            files.add(f)
    return sorted(files)


def load_jsonl(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                print(f"  [skip] {os.path.basename(path)}:{i} JSON parse error", file=sys.stderr)
                continue
            if r.get("prompt") and r.get("label") in ACCEPTED_LABELS:
                rows.append(r)
    return rows


def classify_one(api, prompt, timeout, admin_secret, baseline):
    """
    Calls /api/admin/diag/classify-full and flattens response to legacy shape
    {cx, rule, lang, modal, l2_invoked} so the rest of the pipeline is unchanged.
    """
    body = json.dumps({"prompt": prompt}).encode("utf-8")
    headers = {"Content-Type": "application/json; charset=utf-8"}
    if admin_secret:
        headers["x-admin-secret"] = admin_secret
    req = urllib.request.Request(api, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}: {e.read().decode('utf-8', errors='replace')[:200]}"}
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return {"error": f"{type(e).__name__}: {e}"}

    # Diag response shape: {l1, dyn_conf, l2, serving_layer_floor, final_cx_baselines, ...}
    l1          = raw.get("l1") or {}
    l2          = raw.get("l2") or {}
    baselines   = raw.get("final_cx_baselines") or {}
    cx          = baselines.get(baseline) or l1.get("cx")
    rule        = l1.get("rule") or "?"
    # Annotate rule with L2-override marker so downstream aggregation
    # (l2_invoked detection at aggregate()) keeps working.
    if l2.get("invoked") and l2.get("cx") and l2.get("cx") != l1.get("cx"):
        conf_pct = (l2.get("confidence") or 0) * 100
        rule = f"{rule} [L2-override: {l1.get('cx')}→{l2.get('cx')} conf={conf_pct:.1f}%]"
    return {
        "cx":    cx,
        "rule":  rule,
        "lang":  l1.get("lang"),
        "modal": l1.get("modal"),
    }


def replay(args, all_rows):
    print(f"Classifying {len(all_rows)} prompts via {args.api} (concurrency={args.concurrency})...",
          file=sys.stderr)
    t0 = time.time()
    results = []
    correct_count = 0
    errors_count = 0

    def task(row):
        return row, classify_one(
            args.api, row["prompt"], args.timeout, args.admin_secret, args.baseline,
        )

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as ex:
        for i, (row, result) in enumerate(ex.map(task, all_rows), 1):
            if "error" in result:
                errors_count += 1
                results.append({"row": row, "result": result, "correct": None,
                                "expected": None, "got": None})
            else:
                expected = LABEL_NORMALIZE.get(row["label"], row["label"])
                got = LABEL_NORMALIZE.get(result.get("cx"), result.get("cx"))
                correct = (got == expected)
                if correct:
                    correct_count += 1
                results.append({"row": row, "result": result, "correct": correct,
                                "expected": expected, "got": got})
            if i % 500 == 0 or i == len(all_rows):
                elapsed = time.time() - t0
                rate = i / max(elapsed, 0.001)
                eta = (len(all_rows) - i) / max(rate, 0.001)
                print(f"  [{i}/{len(all_rows)}] {correct_count} correct, "
                      f"{errors_count} errors — {rate:.1f} req/s, ETA {eta:.0f}s",
                      file=sys.stderr)
    return results, time.time() - t0


def aggregate(results):
    by_rule = collections.defaultdict(lambda: {"n": 0, "correct": 0, "l2_invoke": 0})
    by_lang = collections.defaultdict(lambda: {"n": 0, "correct": 0})
    by_turn = collections.defaultdict(lambda: {"n": 0, "correct": 0})
    by_lang_label = collections.defaultdict(lambda: {"n": 0, "correct": 0})
    confusion = collections.Counter()
    wrong_samples = []
    api_errors = []

    for r in results:
        if r["correct"] is None:
            api_errors.append(r)
            continue
        row, result = r["row"], r["result"]
        lang = row.get("lang") or result.get("lang") or "?"
        turn_count = int(row.get("turn_count") or 1)
        rule_name = result.get("rule") or "?"
        l1_rule = rule_name.split(" [L2-override:")[0]
        l2_invoked = "[L2-override:" in rule_name

        by_rule[l1_rule]["n"] += 1
        by_rule[l1_rule]["correct"] += int(r["correct"])
        by_rule[l1_rule]["l2_invoke"] += int(l2_invoked)

        by_lang[lang]["n"] += 1
        by_lang[lang]["correct"] += int(r["correct"])

        turn_bin = "1" if turn_count == 1 else ("2" if turn_count == 2 else "3+")
        by_turn[turn_bin]["n"] += 1
        by_turn[turn_bin]["correct"] += int(r["correct"])

        key = (lang, r["expected"])
        by_lang_label[key]["n"] += 1
        by_lang_label[key]["correct"] += int(r["correct"])

        confusion[(r["expected"], r["got"])] += 1

        if not r["correct"]:
            wrong_samples.append({
                "lang": lang,
                "turn": turn_count,
                "expected": r["expected"],
                "got": r["got"],
                "rule": l1_rule,
                "l2_invoked": l2_invoked,
                "prompt": row["prompt"],
            })

    return {
        "by_rule": dict(by_rule),
        "by_lang": dict(by_lang),
        "by_turn": dict(by_turn),
        "by_lang_label": dict(by_lang_label),
        "confusion": dict(confusion),
        "wrong_samples": wrong_samples,
        "api_errors": api_errors,
    }


def fmt_pct(num, den):
    return f"{(num / den * 100):.1f}%" if den else "—"


def write_report(stats, results, elapsed, args, report_path, csv_path):
    total = len(results)
    correct = sum(1 for r in results if r["correct"] is True)
    errors = len(stats["api_errors"])
    valid = total - errors

    L = []
    L.append(f"# Predict Replay Report — {datetime.datetime.now().isoformat(timespec='seconds')}")
    L.append("")
    L.append(f"- **API**: `{args.api}`")
    L.append(f"- **Source**: `{args.file or args.dir}`")
    L.append(f"- **Total**: {total} prompts  |  Valid: {valid}  |  API errors: {errors}")
    L.append(f"- **Overall accuracy**: {fmt_pct(correct, valid)} ({correct}/{valid})")
    L.append(f"- **Wall time**: {elapsed:.1f}s ({total / max(elapsed, 0.001):.1f} req/s)")
    L.append("")

    L.append("## Per-language accuracy (sorted worst first)")
    L.append("")
    L.append("| Lang | n | Accuracy |")
    L.append("|---|---|---|")
    for lang, st in sorted(stats["by_lang"].items(), key=lambda kv: kv[1]["correct"] / max(kv[1]["n"], 1)):
        if st["n"] == 0:
            continue
        a = st["correct"] / st["n"] * 100
        marker = "❌" if a < 85 else "⚠️" if a < 95 else "✅"
        L.append(f"| {marker} {lang} | {st['n']} | {a:.1f}% |")
    L.append("")

    L.append("## Per-turn-count accuracy")
    L.append("")
    L.append("| Turn | n | Accuracy |")
    L.append("|---|---|---|")
    for k in ("1", "2", "3+"):
        st = stats["by_turn"].get(k)
        if not st or st["n"] == 0:
            continue
        L.append(f"| turn = {k} | {st['n']} | {st['correct'] / st['n'] * 100:.1f}% |")
    L.append("")
    L.append("> Note: classify endpoint is single-turn — multi-turn rows are tested as if "
             "context-free. Multi-turn slice accuracy reflects L1-only behavior on the current "
             "user prompt.")
    L.append("")

    L.append("## Per-rule accuracy (sorted worst first; min n=5)")
    L.append("")
    L.append("| Rule | n | L1 Accuracy | L2 invoke rate |")
    L.append("|---|---|---|---|")
    for rule, st in sorted(stats["by_rule"].items(), key=lambda kv: kv[1]["correct"] / max(kv[1]["n"], 1)):
        if st["n"] < 5:
            continue
        a = st["correct"] / st["n"] * 100
        l2 = st["l2_invoke"] / st["n"] * 100
        marker = "❌" if a < 70 else "⚠️" if a < 85 else "✅"
        L.append(f"| {marker} `{rule}` | {st['n']} | {a:.1f}% | {l2:.1f}% |")
    L.append("")

    L.append("## Per-lang × expected-label breakdown (min n=10)")
    L.append("")
    L.append("| Lang | Expected | n | Accuracy |")
    L.append("|---|---|---|---|")
    for (lang, label), st in sorted(stats["by_lang_label"].items(),
                                     key=lambda kv: kv[1]["correct"] / max(kv[1]["n"], 1)):
        if st["n"] < 10:
            continue
        a = st["correct"] / st["n"] * 100
        marker = "❌" if a < 80 else "⚠️" if a < 90 else "✅"
        L.append(f"| {marker} {lang} | {label} | {st['n']} | {a:.1f}% |")
    L.append("")

    L.append("## Confusion matrix")
    L.append("")
    L.append("| Expected ↓  \\  Got → | HIGH | MED | LOW |")
    L.append("|---|---|---|---|")
    for exp in ("HIGH", "MED", "LOW"):
        cells = [stats["confusion"].get((exp, got), 0) for got in ("HIGH", "MED", "LOW")]
        L.append(f"| **{exp}** | {cells[0]} | {cells[1]} | {cells[2]} |")
    L.append("")

    L.append(f"## Wrong samples (showing first 40 of {len(stats['wrong_samples'])})")
    L.append("")
    L.append("| # | Lang | Turn | Expected | Got | Rule | L2? | Prompt |")
    L.append("|---|---|---|---|---|---|---|---|")
    for i, w in enumerate(stats["wrong_samples"][:40], 1):
        p = w["prompt"][:120] + ("…" if len(w["prompt"]) > 120 else "")
        p = p.replace("|", "\\|").replace("\n", " ")
        L.append(f"| {i} | {w['lang']} | {w['turn']} | {w['expected']} | {w['got']} | "
                 f"`{w['rule']}` | {'Y' if w['l2_invoked'] else 'N'} | {p} |")
    L.append("")

    if stats["api_errors"]:
        L.append(f"## API errors ({len(stats['api_errors'])} — first 10)")
        L.append("")
        for e in stats["api_errors"][:10]:
            L.append(f"- `{e['result'].get('error', '?')}`  "
                     f"prompt: `{e['row'].get('prompt', '')[:80]}`")
        L.append("")

    with open(report_path, "w", encoding="utf-8") as f:
        f.write("\n".join(L))
    print(f"\n📄 Markdown report → {report_path}", file=sys.stderr)

    # Raw CSV for downstream analysis
    with open(csv_path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["lang", "turn_count", "label_expected", "cx_got", "correct",
                    "rule", "l2_invoked", "confidence", "prompt"])
        for r in results:
            if r["correct"] is None:
                continue
            row = r["row"]
            result = r["result"]
            rule_name = result.get("rule") or ""
            l1_rule = rule_name.split(" [L2-override:")[0]
            l2_invoked = "[L2-override:" in rule_name
            w.writerow([
                row.get("lang") or "?",
                row.get("turn_count") or 1,
                r["expected"],
                r["got"],
                int(bool(r["correct"])),
                l1_rule,
                int(l2_invoked),
                result.get("confidence", ""),
                row["prompt"],
            ])
    print(f"📊 Raw CSV → {csv_path}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--dir", default="data", help="JSONL directory (default: data)")
    ap.add_argument("--file", help="Single JSONL file (overrides --dir)")
    ap.add_argument("--api", default=DEFAULT_API,
                    help=f"Classify endpoint (default: {DEFAULT_API})")
    ap.add_argument("--out", help="Markdown report path (default: data/reports/PREDICT_REPLAY_<date>.md)")
    ap.add_argument("--csv", help="CSV output path (default: same dir as --out, .csv extension)")
    ap.add_argument("--limit", type=int, help="Cap rows for testing")
    ap.add_argument("--concurrency", type=int, default=4, help="Parallel requests (default 4)")
    ap.add_argument("--timeout", type=float, default=10.0)
    ap.add_argument("--admin-secret", default=os.environ.get("CASCA_ADMIN_SECRET", ""),
                    help="x-admin-secret header (default: $CASCA_ADMIN_SECRET)")
    ap.add_argument("--baseline", default="l1_only", choices=sorted(VALID_BASELINES),
                    help="Which baseline cx to evaluate against ground truth (default: l1_only)")
    args = ap.parse_args()

    if "diag/classify-full" in args.api and not args.admin_secret:
        print("ERROR: --admin-secret (or $CASCA_ADMIN_SECRET) required for diag endpoint.",
              file=sys.stderr)
        sys.exit(2)

    # Discover input
    if args.file:
        files = [args.file]
    else:
        if not os.path.isdir(args.dir):
            print(f"--dir {args.dir} not found", file=sys.stderr)
            sys.exit(1)
        files = discover_files(args.dir)
    if not files:
        print(f"No JSONL files found", file=sys.stderr)
        sys.exit(1)

    print(f"Loading {len(files)} JSONL file(s)...", file=sys.stderr)
    all_rows = []
    for f in files:
        rows = load_jsonl(f)
        print(f"  {os.path.basename(f)}: {len(rows)} rows", file=sys.stderr)
        all_rows.extend(rows)

    if args.limit:
        all_rows = all_rows[:args.limit]
        print(f"  (capped to {args.limit})", file=sys.stderr)

    if not all_rows:
        print("No rows to classify.", file=sys.stderr)
        sys.exit(1)

    # Output paths
    if not args.out:
        date = datetime.date.today().strftime("%Y%m%d")
        args.out = os.path.join("data", "reports", f"PREDICT_REPLAY_{date}.md")
    if not args.csv:
        args.csv = args.out.rsplit(".", 1)[0] + ".csv"
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)

    results, elapsed = replay(args, all_rows)
    stats = aggregate(results)
    write_report(stats, results, elapsed, args, args.out, args.csv)


if __name__ == "__main__":
    main()
