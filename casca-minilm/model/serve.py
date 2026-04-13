"""
MiniLM Inference — classify prompts into HIGH / MED / LOW.

Loads a fine-tuned checkpoint (or base model if no checkpoint).
Provides predict(prompt) → { label, confidence, probabilities }.
"""

import os
import torch
import numpy as np
from transformers import AutoTokenizer, AutoModelForSequenceClassification

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

    _tokenizer = AutoTokenizer.from_pretrained(model_name)
    _model = AutoModelForSequenceClassification.from_pretrained(
        model_name,
        num_labels=num_labels,
        ignore_mismatched_sizes=True,
    )
    _model.to(_device)
    _model.eval()

    print(f"[minilm] Model loaded: {model_name} → {_device}")
    return True


def predict(prompt: str) -> dict:
    """
    Classify a single prompt.

    Returns:
        {
            "label": "HIGH" | "MED" | "LOW",
            "confidence": float (0.0-1.0, softmax probability of top class),
            "probabilities": { "HIGH": float, "MED": float, "LOW": float }
        }
    """
    if _model is None or _tokenizer is None:
        raise RuntimeError("Model not loaded. Call load_model() first.")

    inputs = _tokenizer(
        prompt,
        return_tensors="pt",
        truncation=True,
        max_length=256,
        padding="max_length",
    )
    inputs = {k: v.to(_device) for k, v in inputs.items()}

    with torch.no_grad():
        outputs = _model(**inputs)
        logits = outputs.logits[0]
        probs = torch.softmax(logits, dim=-1).cpu().numpy()

    top_idx = int(np.argmax(probs))
    label = LABEL_MAP[top_idx]
    confidence = float(probs[top_idx])

    probabilities = {LABEL_MAP[i]: float(probs[i]) for i in range(len(probs))}

    return {
        "label": label,
        "confidence": confidence,
        "probabilities": probabilities,
    }
