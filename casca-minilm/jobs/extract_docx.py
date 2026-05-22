"""
Casca MiniLM — Linguist DOCX → JSONL extractor

Reads a Word document whose paragraphs each contain one JSON object
(the format linguists deliver), and writes a clean .jsonl ready for
validate_batch.py.

Usage:
    python jobs/extract_docx.py "path/to/JA L12 batch 2.docx"
    python jobs/extract_docx.py "path/to/JA L12 batch 2.docx" --out data/ja_L12_batch_2.jsonl
    python jobs/extract_docx.py --dir c:/casca --glob "*L12 batch 2.docx" --out-dir data/
"""

import argparse
import json
import sys
import re
from pathlib import Path
from glob import glob

try:
    import docx
except ImportError:
    print("ERROR: python-docx not installed. Run: pip install python-docx", file=sys.stderr)
    sys.exit(2)


def default_jsonl_name(docx_path: Path) -> str:
    """'JA L12 batch 2.docx' -> 'ja_L12_batch_2.jsonl'"""
    stem = docx_path.stem
    parts = stem.split()
    if not parts:
        return stem.lower() + ".jsonl"
    lang = parts[0].lower()
    rest = "_".join(parts[1:])
    return f"{lang}_{rest}.jsonl" if rest else f"{lang}.jsonl"


def extract(docx_path: Path, out_path: Path) -> dict:
    doc = docx.Document(str(docx_path))
    written = 0
    bad = 0
    bad_lines = []
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        for idx, p in enumerate(doc.paragraphs, 1):
            text = p.text.strip()
            if not text:
                continue
            try:
                obj = json.loads(text)
            except json.JSONDecodeError as e:
                bad += 1
                bad_lines.append((idx, str(e), text[:80]))
                continue
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")
            written += 1
    return {"written": written, "bad": bad, "bad_lines": bad_lines}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path", nargs="?", help="Single docx file")
    ap.add_argument("--out", "-o", help="Output jsonl path (single-file mode)")
    ap.add_argument("--dir", help="Directory to scan")
    ap.add_argument("--glob", default="*.docx", help="Glob within --dir")
    ap.add_argument("--out-dir", default="data", help="Output dir for batch mode")
    args = ap.parse_args()

    if args.path:
        src = Path(args.path)
        out = Path(args.out) if args.out else Path(args.out_dir) / default_jsonl_name(src)
        out.parent.mkdir(parents=True, exist_ok=True)
        res = extract(src, out)
        print(f"{src.name} -> {out} (written={res['written']}, bad={res['bad']})")
        for ln, err, snippet in res["bad_lines"]:
            print(f"  bad line {ln}: {err} | {snippet}", file=sys.stderr)
        return

    if args.dir:
        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        files = sorted(glob(str(Path(args.dir) / args.glob)))
        if not files:
            print(f"No files match {args.glob} in {args.dir}", file=sys.stderr)
            sys.exit(1)
        total_written, total_bad = 0, 0
        for fp in files:
            src = Path(fp)
            out = out_dir / default_jsonl_name(src)
            res = extract(src, out)
            total_written += res["written"]
            total_bad += res["bad"]
            print(f"{src.name} -> {out.name} (written={res['written']}, bad={res['bad']})")
        print(f"\nDone: {len(files)} files, {total_written} rows written, {total_bad} bad lines")
        return

    ap.error("Provide either a path or --dir")


if __name__ == "__main__":
    main()
