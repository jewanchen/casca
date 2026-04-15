"""
Casca MiniLM Service — FastAPI application.

Endpoints:
  POST /predict              — Classify prompt → { label, confidence }
  POST /train/trigger        — Trigger incremental fine-tune from Supabase
  POST /train/import         — Batch import JSONL data and train
  POST /train/cold-start     — Cold start from files in data/ directory
  GET  /model/status         — Current model version and metrics
  GET  /report/rule-health   — Rule accuracy report from Supabase
  GET  /health               — Health check
"""

import os
import json
import tempfile
from pathlib import Path
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, UploadFile, File
from pydantic import BaseModel
from supabase import create_client

load_dotenv()

from model.serve import load_model, predict
from model.train import (
    train, load_jsonl, load_from_supabase, evaluate,
    LABEL_TO_ID, PromptDataset,
)


# ── Supabase client ──────────────────────────────────────────────
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
sb = create_client(SUPABASE_URL, SUPABASE_KEY) if SUPABASE_URL and SUPABASE_KEY else None

# ── State ────────────────────────────────────────────────────────
active_version = None
is_training = False


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load model on startup."""
    global active_version

    # Try to load the latest active checkpoint from DB
    checkpoint = None
    if sb:
        try:
            res = sb.table("minilm_versions").select("version, checkpoint_path").eq(
                "is_active", True
            ).limit(1).execute()
            if res.data:
                candidate = res.data[0]["checkpoint_path"]
                # Only use checkpoint if file actually exists on disk
                # (Railway containers lose local files between deploys)
                if candidate and Path(candidate).exists():
                    checkpoint = candidate
                    active_version = res.data[0]["version"]
                else:
                    print(f"[app] DB says active={res.data[0]['version']} but checkpoint file missing on disk: {candidate}")
                    print(f"[app] → falling back to base model. Re-run cold start to restore.")
        except Exception as e:
            print(f"[app] DB lookup failed: {e}")

    # Fallback: check env or use base model
    if not checkpoint:
        env_ckpt = os.getenv("ACTIVE_CHECKPOINT")
        if env_ckpt and Path(env_ckpt).exists():
            checkpoint = env_ckpt
            active_version = Path(env_ckpt).name
        else:
            checkpoint = None
            active_version = "base"

    # Try loading; if it fails (e.g. corrupt checkpoint), fall back to base model
    try:
        load_model(checkpoint)
    except Exception as e:
        print(f"[app] load_model({checkpoint}) failed: {e}")
        print(f"[app] → loading base model as fallback")
        active_version = "base"
        load_model(None)

    print(f"[app] Ready — version={active_version}")

    yield  # App runs

    print("[app] Shutting down")


app = FastAPI(title="Casca MiniLM Service", version="1.0.0", lifespan=lifespan)


# ═══════════════════════════════════════════════════════════════
#  SCHEMAS
# ═══════════════════════════════════════════════════════════════

class PredictRequest(BaseModel):
    prompt: str

class PredictResponse(BaseModel):
    label: str
    confidence: float
    probabilities: dict[str, float]

class TrainResponse(BaseModel):
    version: str
    checkpoint_path: str
    val_accuracy: float
    val_f1: float
    training_samples_count: int
    duration_s: float

class ModelStatus(BaseModel):
    active_version: str | None
    is_training: bool


# ═══════════════════════════════════════════════════════════════
#  ENDPOINTS
# ═══════════════════════════════════════════════════════════════

@app.post("/predict", response_model=PredictResponse)
async def api_predict(req: PredictRequest):
    """Classify a prompt using the active MiniLM model."""
    try:
        result = predict(req.prompt)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/train/trigger", response_model=TrainResponse)
async def api_train_trigger():
    """
    Trigger incremental fine-tune using untrained samples from Supabase.
    Fetches samples where used_for_training = FALSE, trains, saves checkpoint.
    """
    global is_training, active_version

    if is_training:
        raise HTTPException(status_code=409, detail="Training already in progress.")
    if not sb:
        raise HTTPException(status_code=503, detail="Supabase not configured.")

    is_training = True
    try:
        # Fetch untrained samples
        prompts, labels, sample_ids = load_from_supabase(sb)
        if len(prompts) < 10:
            raise HTTPException(
                status_code=400,
                detail=f"Not enough untrained samples ({len(prompts)}). Need at least 10.",
            )

        # Split 90/10 for train/val
        split_idx = max(1, int(len(prompts) * 0.9))
        train_p, train_l = prompts[:split_idx], labels[:split_idx]
        val_p, val_l = prompts[split_idx:], labels[split_idx:]

        # Use current active checkpoint as base (incremental)
        base = os.getenv("ACTIVE_CHECKPOINT") or os.getenv("MODEL_NAME", "microsoft/MiniLM-L6-H384-uncased")

        result = train(train_p, train_l, val_p, val_l, base_model=base)

        # Mark samples as trained
        for sid in sample_ids:
            sb.table("training_samples").update({
                "used_for_training": True,
                "model_version": result["version"],
            }).eq("id", sid).execute()

        # Register version in DB
        sb.table("minilm_versions").insert({
            "version": result["version"],
            "training_samples_count": result["training_samples_count"],
            "val_accuracy": result["val_accuracy"],
            "val_f1": result["val_f1"],
            "checkpoint_path": result["checkpoint_path"],
            "is_active": False,  # Manual activation for safety
        }).execute()

        return TrainResponse(**result)
    finally:
        is_training = False


@app.post("/train/import", response_model=TrainResponse)
async def api_train_import(file: UploadFile = File(...)):
    """
    Upload a JSONL file and train on it.
    JSONL format: { "prompt": "...", "label": "HIGH|MED|LOW", ... }
    """
    global is_training

    if is_training:
        raise HTTPException(status_code=409, detail="Training already in progress.")

    is_training = True
    try:
        # Save uploaded file temporarily
        content = await file.read()
        with tempfile.NamedTemporaryFile(mode="wb", suffix=".jsonl", delete=False) as tmp:
            tmp.write(content)
            tmp_path = tmp.name

        prompts, labels = load_jsonl(tmp_path)
        os.unlink(tmp_path)

        if len(prompts) < 5:
            raise HTTPException(status_code=400, detail=f"Too few samples ({len(prompts)}).")

        # Also write to training_samples in DB for tracking
        if sb:
            for p, l in zip(prompts, labels):
                label_str = {0: "HIGH", 1: "MED", 2: "LOW"}[l]
                sb.table("training_samples").insert({
                    "prompt_masked": p,
                    "l1_label": label_str,
                    "l1_rule": "batch_import",
                    "judge_label": label_str,
                    "l1_correct": True,
                    "serving_label": label_str,
                    "serving_correct": True,
                    "source": "batch",
                    "used_for_training": True,
                }).execute()

        # Split 90/10
        split_idx = max(1, int(len(prompts) * 0.9))
        result = train(
            prompts[:split_idx], labels[:split_idx],
            prompts[split_idx:], labels[split_idx:],
        )

        return TrainResponse(**result)
    finally:
        is_training = False


@app.post("/train/cold-start", response_model=TrainResponse)
async def api_cold_start():
    """
    Cold start fine-tune using files in data/ directory.
    Expects: data/train.jsonl, data/val.jsonl (optional: data/test.jsonl)
    """
    global is_training

    if is_training:
        raise HTTPException(status_code=409, detail="Training already in progress.")

    data_dir = Path("data")
    train_file = data_dir / "train.jsonl"
    val_file = data_dir / "val.jsonl"

    if not train_file.exists():
        raise HTTPException(status_code=404, detail="data/train.jsonl not found.")

    is_training = True
    try:
        train_p, train_l = load_jsonl(str(train_file))
        val_p, val_l = None, None
        if val_file.exists():
            val_p, val_l = load_jsonl(str(val_file))

        result = train(
            train_p, train_l, val_p, val_l,
            version="v0.1.0_cold_start",
        )

        # Register in DB
        if sb:
            sb.table("minilm_versions").upsert({
                "version": result["version"],
                "training_samples_count": result["training_samples_count"],
                "val_accuracy": result["val_accuracy"],
                "val_f1": result["val_f1"],
                "checkpoint_path": result["checkpoint_path"],
                "is_active": True,
                "notes": "Cold start from 485 samples",
            }, on_conflict="version").execute()

        # Reload the model with new checkpoint
        load_model(result["checkpoint_path"])

        return TrainResponse(**result)
    finally:
        is_training = False


@app.get("/model/status", response_model=ModelStatus)
async def api_model_status():
    """Current model version and training status."""
    return ModelStatus(
        active_version=active_version,
        is_training=is_training,
    )


@app.get("/report/rule-health")
async def api_rule_health():
    """Rule accuracy report from Supabase."""
    if not sb:
        raise HTTPException(status_code=503, detail="Supabase not configured.")

    res = sb.table("rule_accuracy_stats").select("*").order(
        "accuracy_rate", desc=False
    ).execute()

    rules = res.data or []
    broken = [r for r in rules if r["status"] == "BROKEN"]
    degrading = [r for r in rules if r["status"] == "DEGRADING"]
    healthy = [r for r in rules if r["status"] == "HEALTHY"]

    return {
        "total_rules": len(rules),
        "broken": len(broken),
        "degrading": len(degrading),
        "healthy": len(healthy),
        "broken_rules": broken,
        "degrading_rules": degrading,
        "rules": rules,
    }


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model_version": active_version,
        "is_training": is_training,
    }


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=True)
