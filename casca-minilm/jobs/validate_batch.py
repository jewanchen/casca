"""
Casca MiniLM — Data Provider Batch Validator

Validates a JSONL batch from a language expert and produces a markdown report.

Usage:
    python jobs/validate_batch.py path/to/file.jsonl
    python jobs/validate_batch.py path/to/file.jsonl --output report.md
    python jobs/validate_batch.py path/to/file.jsonl --strict      # fail on any warning
"""

import argparse
import json
import sys
import re
from pathlib import Path
from collections import Counter, defaultdict
from datetime import datetime


# ═══════════════════════════════════════════════════════════════
#  CONFIG
# ═══════════════════════════════════════════════════════════════

VALID_LABELS = {"HIGH", "MED", "LOW"}
VALID_LANGS = {
    "ZH", "ZH_SC", "EN", "JA", "FR", "DE", "ES", "IT",
    "KO", "HI", "AR", "TH", "VI", "ID",
    "PT", "RU", "TR", "NL", "PL", "MS",
}
VALID_DOMAINS = {
    "business", "legal", "tech", "finance", "medical",
    "lifestyle", "creative", "general",
}
VALID_CONV_MODES = {
    "PROFESSIONAL", "EMPATHY", "SIMPLE", "CODE_TASK",
    "LEARNING", "LIFESTYLE", "CREATIVE",
}
VALID_NOISE_TYPES = {"FRAGMENT", "ZH-VAGUE", "J-POLY", ""}

# Distribution targets (prompted in the spec)
LABEL_TARGET = {
    "HIGH": (0.25, 0.35),
    "MED":  (0.35, 0.50),
    "LOW":  (0.20, 0.30),
}

# Per-300 boundary case quotas (pro-rated for smaller batches)
QUOTA_PER_300 = {
    "FRAGMENT": 50,
    "VAGUE": 30,        # ZH-VAGUE / J-POLY combined
    "TRIPLE_SETS": 40,  # sets of 3 same-topic LOW/MED/HIGH
}

# PII regex patterns (very rough — flag candidates for human review)
PII_PATTERNS = {
    "EMAIL":    re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}"),
    "PHONE_TW": re.compile(r"\b09\d{2}[\-\s]?\d{3}[\-\s]?\d{3}\b"),
    "PHONE_US": re.compile(r"\b\d{3}[\-\s]\d{3}[\-\s]\d{4}\b"),
    "SSN":      re.compile(r"\b\d{3}[\-\s]\d{2}[\-\s]\d{4}\b"),
    "TW_ID":    re.compile(r"\b[A-Z][12]\d{8}\b"),
    "CREDIT":   re.compile(r"\b(?:\d[ \-]?){13,19}\b"),
}


# ═══════════════════════════════════════════════════════════════
#  CHECKS
# ═══════════════════════════════════════════════════════════════

def load_jsonl(path: Path) -> tuple[list[dict], list[dict]]:
    """Returns (rows, parse_errors)."""
    rows = []
    errors = []
    with open(path, "r", encoding="utf-8") as f:
        for i, line in enumerate(f, 1):
            line = line.rstrip("\n").rstrip("\r")
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as e:
                errors.append({"line": i, "error": str(e)})
    return rows, errors


def check_required_fields(row: dict) -> list[str]:
    """Returns list of error messages for this row."""
    errs = []
    for field in ("prompt", "label", "lang", "annotator"):
        if field not in row or row[field] in (None, ""):
            errs.append(f"missing required field: {field}")

    if "label" in row and row["label"] not in VALID_LABELS:
        errs.append(f"invalid label: {row['label']!r} (must be HIGH/MED/LOW)")

    if "lang" in row and row["lang"] not in VALID_LANGS:
        errs.append(f"invalid lang: {row['lang']!r}")

    if "domain" in row and row["domain"] and row["domain"] not in VALID_DOMAINS:
        errs.append(f"unknown domain: {row['domain']!r}")

    if "conv_mode" in row and row["conv_mode"] and row["conv_mode"] not in VALID_CONV_MODES:
        errs.append(f"unknown conv_mode: {row['conv_mode']!r}")

    if "noise_type" in row and row["noise_type"] not in VALID_NOISE_TYPES:
        errs.append(f"unknown noise_type: {row['noise_type']!r}")

    if "prompt" in row:
        plen = len(row["prompt"])
        if plen < 3:
            errs.append(f"prompt too short ({plen} chars, min 3)")
        if plen > 500:
            errs.append(f"prompt too long ({plen} chars, max 500)")

    if "confidence" in row and row["confidence"] is not None:
        try:
            c = int(row["confidence"])
            if c < 0 or c > 100:
                errs.append(f"confidence out of range: {c}")
        except (TypeError, ValueError):
            errs.append(f"confidence not int: {row['confidence']!r}")

    return errs


def check_pii(prompt: str) -> list[str]:
    """Returns list of PII types found."""
    found = []
    for name, pat in PII_PATTERNS.items():
        if pat.search(prompt or ""):
            found.append(name)
    return found


def detect_duplicates(rows: list[dict]) -> list[tuple[int, int, str]]:
    """Returns list of (idx_a, idx_b, prompt) — exact + case-insensitive duplicates."""
    seen = {}
    dups = []
    for i, r in enumerate(rows):
        p = (r.get("prompt") or "").strip().lower()
        if not p:
            continue
        if p in seen:
            dups.append((seen[p], i, r["prompt"][:60]))
        else:
            seen[p] = i
    return dups


def label_distribution(rows: list[dict]) -> dict:
    counter = Counter(r.get("label") for r in rows if r.get("label") in VALID_LABELS)
    total = sum(counter.values())
    if total == 0:
        return {}
    return {
        label: {"count": counter[label], "pct": counter[label] / total * 100}
        for label in ("HIGH", "MED", "LOW")
    }


def domain_coverage(rows: list[dict]) -> dict:
    counter = Counter(r.get("domain") or "general" for r in rows)
    return dict(counter)


def boundary_cases(rows: list[dict]) -> dict:
    fragments = sum(1 for r in rows if r.get("noise_type") == "FRAGMENT")
    vague = sum(1 for r in rows if r.get("noise_type") in ("ZH-VAGUE", "J-POLY"))

    # Triple sets: rough heuristic — find prompts that share a "topic stem"
    # We approximate by checking if the same notes mention "三連組" or similar markers
    # Better: detect by clustering similar prompts (skipped for simplicity)
    triple_marker = sum(
        1 for r in rows
        if r.get("notes") and ("三連組" in r["notes"] or "triple" in r["notes"].lower())
    )
    triple_sets = triple_marker // 3  # rough

    multi_turn = sum(1 for r in rows if r.get("turn_count", 1) > 1)

    return {
        "FRAGMENT": fragments,
        "VAGUE":    vague,
        "TRIPLE_SETS": triple_sets,
        "MULTI_TURN": multi_turn,
    }


def confidence_distribution(rows: list[dict]) -> dict:
    bins = {"high (>80)": 0, "mid (50-80)": 0, "low (<50)": 0, "missing": 0}
    for r in rows:
        c = r.get("confidence")
        if c is None:
            bins["missing"] += 1
        elif c > 80:
            bins["high (>80)"] += 1
        elif c >= 50:
            bins["mid (50-80)"] += 1
        else:
            bins["low (<50)"] += 1
    return bins


# ═══════════════════════════════════════════════════════════════
#  REPORT
# ═══════════════════════════════════════════════════════════════

def status_emoji(passed: bool, warn: bool = False) -> str:
    if passed: return "✓"
    if warn:   return "⚠"
    return "✗"


def fmt_pct(p: float) -> str:
    return f"{p:.1f}%"


def build_report(path: Path, rows: list[dict], parse_errors: list[dict]) -> tuple[str, dict]:
    """
    Returns (markdown_report, summary_dict).
    summary_dict has 'pass'/'fail' counts and 'overall_pass' bool.
    """
    total = len(rows)
    lines = []
    summary = {"warnings": 0, "errors": 0, "overall_pass": True}

    # ── Header ──────────────────────────────────────────────
    lines.append(f"# Validation Report — `{path.name}`")
    lines.append("")
    lines.append(f"- **Generated**: {datetime.now().isoformat(timespec='seconds')}")
    lines.append(f"- **Total rows**: {total}")
    lines.append(f"- **Parse errors**: {len(parse_errors)}")
    lines.append("")

    if parse_errors:
        lines.append("## ✗ Parse Errors (BLOCKING)")
        lines.append("")
        for pe in parse_errors[:20]:
            lines.append(f"- Line {pe['line']}: {pe['error']}")
        if len(parse_errors) > 20:
            lines.append(f"- ... and {len(parse_errors) - 20} more")
        lines.append("")
        summary["errors"] += len(parse_errors)
        summary["overall_pass"] = False

    if total == 0:
        lines.append("**No valid rows to validate.**")
        return "\n".join(lines), summary

    # ── Field validation ────────────────────────────────────
    field_errs = []
    pii_flags = []
    for i, r in enumerate(rows, 1):
        errs = check_required_fields(r)
        for e in errs:
            field_errs.append((i, e))
        pii = check_pii(r.get("prompt", ""))
        if pii:
            pii_flags.append((i, pii, (r.get("prompt") or "")[:80]))

    lines.append("## Field Validation")
    lines.append("")
    if not field_errs:
        lines.append("✓ All rows pass field-level validation")
    else:
        summary["errors"] += len(field_errs)
        summary["overall_pass"] = False
        lines.append(f"✗ {len(field_errs)} field error(s):")
        for i, e in field_errs[:30]:
            lines.append(f"  - Row {i}: {e}")
        if len(field_errs) > 30:
            lines.append(f"  - ... and {len(field_errs) - 30} more")
    lines.append("")

    # ── PII check ───────────────────────────────────────────
    lines.append("## PII Detection")
    lines.append("")
    if not pii_flags:
        lines.append("✓ No PII patterns detected")
    else:
        summary["warnings"] += len(pii_flags)
        lines.append(f"⚠ {len(pii_flags)} row(s) contain potential PII (please review):")
        for i, types, snippet in pii_flags[:20]:
            lines.append(f"  - Row {i}: {','.join(types)} — `{snippet}`")
    lines.append("")

    # ── Duplicates ──────────────────────────────────────────
    dups = detect_duplicates(rows)
    lines.append("## Duplicates")
    lines.append("")
    if not dups:
        lines.append("✓ No exact/case-insensitive duplicates")
    else:
        summary["warnings"] += len(dups)
        lines.append(f"⚠ {len(dups)} duplicate pair(s):")
        for a, b, p in dups[:15]:
            lines.append(f"  - Row {a+1} == Row {b+1}: `{p}`")
    lines.append("")

    # ── Label distribution ──────────────────────────────────
    dist = label_distribution(rows)
    lines.append("## Label Distribution")
    lines.append("")
    lines.append("| Label | Count | % | Target | Status |")
    lines.append("|---|---|---|---|---|")
    for label in ("HIGH", "MED", "LOW"):
        d = dist.get(label, {"count": 0, "pct": 0})
        lo, hi = LABEL_TARGET[label]
        in_range = (lo * 100) <= d["pct"] <= (hi * 100)
        emoji = "✓" if in_range else "⚠"
        if not in_range:
            summary["warnings"] += 1
        lines.append(
            f"| {label} | {d['count']} | {fmt_pct(d['pct'])} | {int(lo*100)}-{int(hi*100)}% | {emoji} |"
        )
    lines.append("")

    # ── Domain coverage ─────────────────────────────────────
    dc = domain_coverage(rows)
    lines.append("## Domain Coverage")
    lines.append("")
    lines.append("| Domain | Count |")
    lines.append("|---|---|")
    for d in sorted(VALID_DOMAINS):
        cnt = dc.get(d, 0)
        emoji = "" if cnt == 0 else ""
        lines.append(f"| {d} | {cnt} {'⚠ none' if cnt == 0 else ''} |")
    covered = sum(1 for d in VALID_DOMAINS if dc.get(d, 0) > 0)
    lines.append("")
    if covered < 6:
        summary["warnings"] += 1
        lines.append(f"⚠ Only {covered}/8 domains covered (target ≥6)")
    else:
        lines.append(f"✓ {covered}/8 domains covered")
    lines.append("")

    # ── Boundary cases ──────────────────────────────────────
    bc = boundary_cases(rows)
    expected = {k: int(v * total / 300) for k, v in QUOTA_PER_300.items()}
    lines.append("## Boundary Cases")
    lines.append("")
    lines.append("| Type | Count | Pro-rated target | Status |")
    lines.append("|---|---|---|---|")
    for k, target in expected.items():
        actual = bc.get(k, 0)
        emoji = "✓" if actual >= target else "⚠"
        if actual < target:
            summary["warnings"] += 1
        lines.append(f"| {k} | {actual} | {target} (per {total} rows) | {emoji} |")
    lines.append(f"| MULTI_TURN | {bc.get('MULTI_TURN', 0)} | — | ℹ |")
    lines.append("")

    # ── Confidence distribution ─────────────────────────────
    cd = confidence_distribution(rows)
    lines.append("## Confidence Distribution")
    lines.append("")
    lines.append("| Bin | Count | % |")
    lines.append("|---|---|---|")
    for k, v in cd.items():
        pct = (v / total * 100) if total > 0 else 0
        lines.append(f"| {k} | {v} | {fmt_pct(pct)} |")
    lines.append("")
    if cd.get("low (<50)", 0) == 0:
        lines.append("ℹ No low-confidence rows. Consider adding boundary cases with confidence 30-60 — these are most valuable for MiniLM training.")
    lines.append("")

    # ── Annotator info ──────────────────────────────────────
    annotators = Counter(r.get("annotator") for r in rows)
    regions = Counter(r.get("region") for r in rows)
    langs = Counter(r.get("lang") for r in rows)
    lines.append("## Metadata")
    lines.append("")
    lines.append(f"- **Annotators**: {dict(annotators)}")
    lines.append(f"- **Regions**: {dict(regions)}")
    lines.append(f"- **Languages**: {dict(langs)}")
    lines.append("")

    # ── Final verdict ───────────────────────────────────────
    lines.append("## Final Verdict")
    lines.append("")
    if summary["errors"] > 0:
        lines.append(f"### ✗ REJECTED")
        lines.append(f"- {summary['errors']} blocking error(s)")
        lines.append(f"- {summary['warnings']} warning(s)")
        lines.append("")
        lines.append("**Action**: Fix all errors and resubmit.")
    elif summary["warnings"] > 5:
        lines.append(f"### ⚠ ACCEPTED WITH WARNINGS")
        lines.append(f"- 0 errors")
        lines.append(f"- {summary['warnings']} warning(s)")
        lines.append("")
        lines.append("**Action**: Review warnings. May proceed but please address in next batch.")
    else:
        lines.append(f"### ✓ PASSED")
        lines.append(f"- 0 errors")
        lines.append(f"- {summary['warnings']} warning(s)")
        lines.append("")
        lines.append("**Action**: Ready for ingestion via `/api/admin/pathb/upload`.")
    lines.append("")

    return "\n".join(lines), summary


# ═══════════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════════

def main():
    ap = argparse.ArgumentParser(description="Validate a Casca MiniLM data batch JSONL")
    ap.add_argument("path", help="Path to JSONL file")
    ap.add_argument("--output", "-o", help="Write report to file (default: stdout)")
    ap.add_argument("--strict", action="store_true",
                    help="Exit code 1 if any warning")
    args = ap.parse_args()

    path = Path(args.path)
    if not path.exists():
        print(f"ERROR: file not found: {path}", file=sys.stderr)
        sys.exit(2)

    rows, parse_errors = load_jsonl(path)
    report, summary = build_report(path, rows, parse_errors)

    if args.output:
        Path(args.output).write_text(report, encoding="utf-8")
        print(f"Report written to: {args.output}")
        print(f"Verdict: errors={summary['errors']}, warnings={summary['warnings']}")
    else:
        print(report)

    # Exit code
    if summary["errors"] > 0:
        sys.exit(1)
    if args.strict and summary["warnings"] > 0:
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
