"""
Checkpoint persistence to Supabase Storage.

MiniLM fine-tune produces a directory with multiple files:
  config.json, model.safetensors, tokenizer.json, vocab.txt, ...

Two storage layouts are supported on read (download_checkpoint):

  1. Single tar.gz at bucket root  → "{version}.tar.gz"
     Written by server-side training (/train/trigger, /train/import,
     /train/cold-start) via upload_checkpoint() below.

  2. 4-part split in subdir        → "checkpoints/{version}/{file}.part{N}"
     Written by Colab notebooks (colab_train_L12.ipynb) that chunk large
     weights (>40MB) to stay under Supabase Storage's 50MB per-object limit.
     Loose support files (config.json, tokenizer.json, ...) live alongside.

upload_checkpoint() only writes layout 1; Colab writes layout 2 directly.
"""

import os
import io
import re
import tarfile
import shutil
from pathlib import Path
from supabase import Client

BUCKET = "minilm-checkpoints"
_PART_RE = re.compile(r'^(?P<base>.+)\.part(?P<n>\d+)$')


def upload_checkpoint(sb: Client, version: str, local_dir: str) -> str:
    """
    Tar+gzip the checkpoint directory and upload to Supabase Storage.

    Returns: storage path (e.g. 'v0.1.0_cold_start.tar.gz')
    Raises on failure.
    """
    local_path = Path(local_dir)
    if not local_path.exists() or not local_path.is_dir():
        raise FileNotFoundError(f"Checkpoint dir not found: {local_dir}")

    # Build in-memory tar.gz
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        # Add all files inside the directory at the archive root
        for item in local_path.iterdir():
            if item.is_file():
                tar.add(str(item), arcname=item.name)
    buf.seek(0)
    data = buf.getvalue()
    size_mb = len(data) / (1024 * 1024)

    storage_path = f"{version}.tar.gz"
    print(f"[storage] uploading {storage_path} ({size_mb:.1f} MB)…")

    # Upload (overwrite if exists)
    try:
        sb.storage.from_(BUCKET).upload(
            path=storage_path,
            file=data,
            file_options={
                "content-type": "application/gzip",
                "upsert": "true",
            },
        )
    except Exception as e:
        # supabase-py may raise on upsert; try update fallback
        msg = str(e).lower()
        if "exists" in msg or "duplicate" in msg:
            sb.storage.from_(BUCKET).update(
                path=storage_path,
                file=data,
                file_options={"content-type": "application/gzip"},
            )
        else:
            raise

    print(f"[storage] uploaded {storage_path} successfully")
    return storage_path


def download_checkpoint(sb: Client, storage_path: str, target_dir: str) -> bool:
    """
    Download a checkpoint and populate target_dir as a flat HuggingFace-loadable directory.

    Tries two layouts in order:
      1. Single tar.gz at bucket root (legacy server-side training).
      2. 4-part split under checkpoints/{version}/ (Colab notebooks).

    Returns True on success, False on failure (caller falls back to base model).
    """
    target = Path(target_dir)

    if target.exists() and any(target.iterdir()):
        print(f"[storage] checkpoint already on disk: {target_dir}")
        return True

    if _try_tar_gz(sb, storage_path, target):
        return True

    # Derive version from storage_path so we can look in checkpoints/{version}/.
    version = storage_path[:-7] if storage_path.endswith('.tar.gz') else storage_path
    if _try_part_split(sb, version, target):
        return True

    print(f"[storage] all layouts exhausted for {storage_path} — falling back to base")
    return False


def _try_tar_gz(sb: Client, storage_path: str, target: Path) -> bool:
    """Layout 1: single tar.gz at bucket root."""
    print(f"[storage] trying tar.gz: {storage_path}")
    try:
        data = sb.storage.from_(BUCKET).download(storage_path)
    except Exception as e:
        print(f"[storage] tar.gz download failed: {e}")
        return False

    try:
        target.mkdir(parents=True, exist_ok=True)
        buf = io.BytesIO(data)
        with tarfile.open(fileobj=buf, mode="r:gz") as tar:
            tar.extractall(path=str(target))
        n = len(list(target.iterdir()))
        print(f"[storage] extracted {n} files from tar.gz into {target}")
        return True
    except Exception as e:
        print(f"[storage] tar.gz extraction failed: {e}")
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
        return False


def _try_part_split(sb: Client, version: str, target: Path) -> bool:
    """Layout 2: 4-part split in checkpoints/{version}/, reassemble part0..N."""
    subdir = f"checkpoints/{version}"
    print(f"[storage] trying part-split: {subdir}/")

    try:
        listing = sb.storage.from_(BUCKET).list(path=subdir)
    except Exception as e:
        print(f"[storage] list {subdir} failed: {e}")
        return False

    if not listing:
        print(f"[storage] {subdir}/ empty or not accessible")
        return False

    file_names = [item['name'] for item in listing if item.get('name')]
    print(f"[storage] found {len(file_names)} files in {subdir}/")

    # Categorize into part-split groups vs loose files.
    groups: dict[str, list[tuple[int, str]]] = {}
    loose: list[str] = []
    for name in file_names:
        m = _PART_RE.match(name)
        if m:
            groups.setdefault(m.group('base'), []).append((int(m.group('n')), name))
        else:
            loose.append(name)

    # Download to a staging dir; only swap into target on full success.
    staging = target.with_suffix('.staging')
    if staging.exists():
        shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, exist_ok=True)

    try:
        for name in loose:
            data = sb.storage.from_(BUCKET).download(f"{subdir}/{name}")
            (staging / name).write_bytes(data)
            print(f"[storage]   copied {name} ({len(data)/1024/1024:.2f} MB)")

        for base, parts in groups.items():
            parts.sort(key=lambda x: x[0])
            indices = [p[0] for p in parts]
            if indices != list(range(len(parts))):
                raise RuntimeError(
                    f"{base}: part indices {indices} not contiguous from 0"
                )
            total = 0
            with open(staging / base, 'wb') as out:
                for _, part_name in parts:
                    chunk = sb.storage.from_(BUCKET).download(f"{subdir}/{part_name}")
                    out.write(chunk)
                    total += len(chunk)
            print(f"[storage]   reassembled {base} from {len(parts)} parts → {total/1024/1024:.2f} MB")

        flat = sorted(p.name for p in staging.iterdir())
        has_weights = any(n in flat for n in ('model.safetensors', 'pytorch_model.bin'))
        if 'config.json' not in flat or not has_weights:
            raise RuntimeError(
                f"sanity check failed: contents={flat} (need config.json + model weights)"
            )

        # Atomic-ish swap: remove target if present, rename staging.
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
        staging.rename(target)
        print(f"[storage] part-split OK → {len(flat)} files in {target}")
        return True

    except Exception as e:
        print(f"[storage] part-split failed: {e}")
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
        return False


def storage_path_for(version: str) -> str:
    """Standard storage path naming (layout 1; download_checkpoint auto-detects)."""
    return f"{version}.tar.gz"
