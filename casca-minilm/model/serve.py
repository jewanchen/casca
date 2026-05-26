"""
MiniLM Inference — classify prompts into HIGH / MED / LOW.

Loads a fine-tuned checkpoint (or base model if no checkpoint).
Provides predict(prompt) → { label, confidence, probabilities }.
"""

import os
import time
import torch
import numpy as np
from transformers import AutoModelForSequenceClassification, BertTokenizerFast

LABEL_MAP = {0: "HIGH", 1: "MED", 2: "LOW"}
LABEL_TO_ID = {"HIGH": 0, "MED": 1, "LOW": 2}

_tokenizer = None
_model = None
_device = None


def load_model(checkpoint_path: str | None = None):
    """Load or reload model from checkpoint (or base model)."""
    global _tokenizer, _model, _device

    model_name = checkpoint_path or os.getenv(
        "MODEL_NAME", "microsoft/MiniLM-L6-H384-uncased"
    )
    num_labels = int(os.getenv("NUM_LABELS", "3"))

    _device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    # Force the Rust tokenizer. AutoTokenizer.from_pretrained(..., use_fast=True)
    # was not upgrading because tokenizer_config.json hard-codes
    # `"tokenizer_class": "BertTokenizer"`. Bypass class resolution by using
    # BertTokenizerFast directly — MiniLM is BERT-family so this is safe.
    _tokenizer = BertTokenizerFast.from_pretrained(model_name)
    _model = AutoModelForSequenceClassification.from_pretrained(
        model_name,
        num_labels=num_labels,
        ignore_mismatched_sizes=True,
    )
    _model.to(_device)
    _model.eval()

    print(
        f"[minilm] Model loaded: {model_name} → {_device} "
        f"tokenizer={type(_tokenizer).__name__}",
        flush=True,
    )
    return True


# Token budget when context_prompt is supplied. Tokenizer pair encoding will
# truncate the longer-of-the-two when total exceeds max_length=256; we further
# cap context_prompt at CONTEXT_MAX_TOKENS to keep ≥175 tokens for the current
# prompt. See contract 2026-05-19_l2-multi-turn-context.md §schema_assumptions.
CONTEXT_MAX_TOKENS = 80


def predict(prompt: str, context_prompt: str | None = None) -> dict:
    """
    Classify a single prompt (optionally with previous-turn context).

    When ``context_prompt`` is provided and non-empty, the tokenizer encodes
    the input as a (context, prompt) pair so the model sees the previous
    turn followed by ``[SEP]`` then the current turn. Empty / None ⇒ behaves
    identically to the legacy single-input path.

    L2 receives raw previous-turn text only. Structured session metadata
    (lastTier, convMode, fragmentStreak, …) is consumed by L1.

    Returns:
        {
            "label": "HIGH" | "MED" | "LOW",
            "confidence": float (0.0-1.0, softmax probability of top class),
            "probabilities": { "HIGH": float, "MED": float, "LOW": float }
        }
    """
    if _model is None or _tokenizer is None:
        raise RuntimeError("Model not loaded. Call load_model() first.")

    _t0 = time.perf_counter()
    has_context = isinstance(context_prompt, str) and context_prompt.strip()

    if has_context:
        # Pre-truncate context_prompt from the LEFT so the most-recent
        # tokens (closest to the [SEP]) are preserved — those are the ones
        # the current prompt is responding to.
        ctx_ids = _tokenizer.encode(
            context_prompt,
            add_special_tokens=False,
            truncation=True,
            max_length=CONTEXT_MAX_TOKENS,
        )
        ctx_text = _tokenizer.decode(ctx_ids, skip_special_tokens=True)
        inputs = _tokenizer(
            ctx_text,
            prompt,
            return_tensors="pt",
            truncation="only_second",  # if total > 256, truncate the current prompt, not context
            max_length=256,
            padding="max_length",
        )
    else:
        inputs = _tokenizer(
            prompt,
            return_tensors="pt",
            truncation=True,
            max_length=256,
            padding="max_length",
        )
    inputs = {k: v.to(_device) for k, v in inputs.items()}
    _t1 = time.perf_counter()

    with torch.no_grad():
        outputs = _model(**inputs)
        logits = outputs.logits[0]
        probs = torch.softmax(logits, dim=-1).cpu().numpy()
    _t2 = time.perf_counter()

    top_idx = int(np.argmax(probs))
    label = LABEL_MAP[top_idx]
    confidence = float(probs[top_idx])

    probabilities = {LABEL_MAP[i]: float(probs[i]) for i in range(len(probs))}
    _t3 = time.perf_counter()

    # Latency breakdown — single log line per /predict call.
    # tok = tokenizer encode + device move
    # fwd = torch forward + softmax + .cpu() (the heavy part)
    # post = argmax + dict build
    print(
        f"[predict] tok={(_t1-_t0)*1000:.0f}ms fwd={(_t2-_t1)*1000:.0f}ms "
        f"post={(_t3-_t2)*1000:.0f}ms total={(_t3-_t0)*1000:.0f}ms "
        f"ctx={'Y' if has_context else 'N'} lbl={label}",
        flush=True,
    )

    return {
        "label": label,
        "confidence": confidence,
        "probabilities": probabilities,
    }
