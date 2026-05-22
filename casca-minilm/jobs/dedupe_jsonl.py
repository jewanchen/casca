"""
Remove duplicate prompts from a JSONL file (case-insensitive, whitespace-trimmed).
Writes back in-place after creating .bak.
"""
import json, sys, shutil
from pathlib import Path

def dedupe(path: Path):
    rows = []
    seen = set()
    dropped = 0
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.rstrip('\n').rstrip('\r')
            if not line.strip(): continue
            try:
                o = json.loads(line)
            except Exception:
                rows.append(('RAW', line)); continue
            key = (o.get('prompt') or '').strip().lower()
            if key and key in seen:
                dropped += 1
                continue
            seen.add(key)
            rows.append(('OBJ', o))
    bak = path.with_suffix(path.suffix + '.bak')
    shutil.copy(path, bak)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        for kind, v in rows:
            if kind == 'OBJ':
                f.write(json.dumps(v, ensure_ascii=False) + '\n')
            else:
                f.write(v + '\n')
    return dropped, len(rows)

if __name__ == '__main__':
    for p in sys.argv[1:]:
        d, n = dedupe(Path(p))
        print(f'{p}: dropped {d}, kept {n}')
