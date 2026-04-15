"""
Checkpoint persistence to Supabase Storage.

MiniLM fine-tune produces a directory with multiple files:
  config.json, model.safetensors, tokenizer.json, vocab.txt, ...

We tar.gz the directory, upload as a single object, and reverse on load.
"""

import os
import io
import tarfile
import shutil
from pathlib import Path
from supabase import Client

BUCKET = "minilm-checkpoints"


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
    Download tar.gz from Supabase Storage and extract into target_dir.

    Returns True on success, False on failure (caller falls back to base model).
    """
    target = Path(target_dir)

    # If already present locally with files, skip download
    if target.exists() and any(target.iterdir()):
        print(f"[storage] checkpoint already on disk: {target_dir}")
        return True

    print(f"[storage] downloading {storage_path} → {target_dir}…")
    try:
        data = sb.storage.from_(BUCKET).download(storage_path)
    except Exception as e:
        print(f"[storage] download failed: {e}")
        return False

    # Extract
    try:
        target.mkdir(parents=True, exist_ok=True)
        buf = io.BytesIO(data)
        with tarfile.open(fileobj=buf, mode="r:gz") as tar:
            tar.extractall(path=str(target))
        print(f"[storage] extracted {len(list(target.iterdir()))} files into {target_dir}")
        return True
    except Exception as e:
        print(f"[storage] extraction failed: {e}")
        # Cleanup partial extract
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
        return False


def storage_path_for(version: str) -> str:
    """Standard storage path naming."""
    return f"{version}.tar.gz"
