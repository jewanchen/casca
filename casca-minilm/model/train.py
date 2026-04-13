"""
MiniLM Training — fine-tune on Casca classification data.

Supports:
  1. Cold start from JSONL files (train.jsonl / val.jsonl / test.jsonl)
  2. Incremental training from Supabase training_samples table
  3. Batch import from uploaded JSONL

Saves checkpoints to CHECKPOINT_DIR with version naming.
"""

import os
import json
import time
import torch
import numpy as np
from datetime import datetime
from pathlib import Path
from torch.utils.data import Dataset, DataLoader
from transformers import (
    AutoTokenizer,
    AutoModelForSequenceClassification,
    get_linear_schedule_with_warmup,
)
from sklearn.metrics import accuracy_score, f1_score, classification_report

LABEL_TO_ID = {"HIGH": 0, "MED": 1, "LOW": 2}
ID_TO_LABEL = {0: "HIGH", 1: "MED", 2: "LOW"}


class PromptDataset(Dataset):
    """Dataset of (prompt, label) pairs."""

    def __init__(self, prompts: list[str], labels: list[int], tokenizer, max_length=256):
        self.encodings = tokenizer(
            prompts, truncation=True, padding="max_length",
            max_length=max_length, return_tensors="pt",
        )
        self.labels = torch.tensor(labels, dtype=torch.long)

    def __len__(self):
        return len(self.labels)

    def __getitem__(self, idx):
        item = {k: v[idx] for k, v in self.encodings.items()}
        item["labels"] = self.labels[idx]
        return item


def load_jsonl(path: str) -> tuple[list[str], list[int]]:
    """Load JSONL file → (prompts, label_ids)."""
    prompts, labels = [], []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            row = json.loads(line.strip())
            label = row.get("label", "MED")
            if label not in LABEL_TO_ID:
                continue
            prompts.append(row["prompt"])
            labels.append(LABEL_TO_ID[label])
    return prompts, labels


def load_from_supabase(supabase_client, limit: int = 5000) -> tuple[list[str], list[int]]:
    """Fetch untrained samples from Supabase training_samples table."""
    data = (
        supabase_client.table("training_samples")
        .select("id, prompt_masked, judge_label")
        .eq("used_for_training", False)
        .limit(limit)
        .execute()
    )
    prompts, labels, ids = [], [], []
    for row in data.data or []:
        label = row.get("judge_label", "MED")
        if label not in LABEL_TO_ID:
            continue
        prompts.append(row["prompt_masked"])
        labels.append(LABEL_TO_ID[label])
        ids.append(row["id"])
    return prompts, labels, ids


def evaluate(model, dataloader, device) -> dict:
    """Run evaluation and return metrics."""
    model.eval()
    all_preds, all_labels = [], []

    with torch.no_grad():
        for batch in dataloader:
            inputs = {k: v.to(device) for k, v in batch.items() if k != "labels"}
            labels = batch["labels"].to(device)
            outputs = model(**inputs)
            preds = torch.argmax(outputs.logits, dim=-1)
            all_preds.extend(preds.cpu().numpy())
            all_labels.extend(labels.cpu().numpy())

    accuracy = accuracy_score(all_labels, all_preds)
    f1_macro = f1_score(all_labels, all_preds, average="macro")
    report = classification_report(
        all_labels, all_preds,
        target_names=["HIGH", "MED", "LOW"],
        output_dict=True,
    )

    return {
        "accuracy": round(accuracy * 100, 2),
        "f1_macro": round(f1_macro, 4),
        "report": report,
    }


def train(
    train_prompts: list[str],
    train_labels: list[int],
    val_prompts: list[str] | None = None,
    val_labels: list[int] | None = None,
    base_model: str | None = None,
    checkpoint_dir: str | None = None,
    version: str | None = None,
    epochs: int | None = None,
    batch_size: int | None = None,
    learning_rate: float | None = None,
) -> dict:
    """
    Fine-tune MiniLM on classification data.

    Returns: { version, checkpoint_path, val_accuracy, val_f1, training_samples_count }
    """
    # Defaults from env
    base_model = base_model or os.getenv("MODEL_NAME", "microsoft/MiniLM-L6-H384-uncased")
    checkpoint_dir = checkpoint_dir or os.getenv("CHECKPOINT_DIR", "./model/checkpoints")
    epochs = epochs or int(os.getenv("NUM_EPOCHS", "5"))
    batch_size = batch_size or int(os.getenv("TRAIN_BATCH_SIZE", "32"))
    learning_rate = learning_rate or float(os.getenv("LEARNING_RATE", "2e-5"))
    warmup_ratio = float(os.getenv("WARMUP_RATIO", "0.1"))
    version = version or f"v{datetime.now().strftime('%Y%m%d_%H%M%S')}"

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"[train] device={device}, base={base_model}, samples={len(train_prompts)}, epochs={epochs}")

    # Load tokenizer + model
    tokenizer = AutoTokenizer.from_pretrained(base_model)
    model = AutoModelForSequenceClassification.from_pretrained(
        base_model, num_labels=3, ignore_mismatched_sizes=True,
    ).to(device)

    # Datasets
    train_dataset = PromptDataset(train_prompts, train_labels, tokenizer)
    train_loader = DataLoader(train_dataset, batch_size=batch_size, shuffle=True)

    val_loader = None
    if val_prompts and val_labels:
        val_dataset = PromptDataset(val_prompts, val_labels, tokenizer)
        val_loader = DataLoader(val_dataset, batch_size=int(os.getenv("EVAL_BATCH_SIZE", "64")))

    # Optimizer + scheduler
    optimizer = torch.optim.AdamW(model.parameters(), lr=learning_rate, weight_decay=0.01)
    total_steps = len(train_loader) * epochs
    warmup_steps = int(total_steps * warmup_ratio)
    scheduler = get_linear_schedule_with_warmup(optimizer, warmup_steps, total_steps)

    # Training loop
    best_val_acc = 0.0
    best_val_f1 = 0.0
    t0 = time.time()

    for epoch in range(epochs):
        model.train()
        total_loss = 0.0

        for batch in train_loader:
            optimizer.zero_grad()
            inputs = {k: v.to(device) for k, v in batch.items() if k != "labels"}
            labels = batch["labels"].to(device)
            outputs = model(**inputs, labels=labels)
            loss = outputs.loss
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            scheduler.step()
            total_loss += loss.item()

        avg_loss = total_loss / len(train_loader)
        elapsed = time.time() - t0

        # Validation
        val_metrics = None
        if val_loader:
            val_metrics = evaluate(model, val_loader, device)
            best_val_acc = max(best_val_acc, val_metrics["accuracy"])
            best_val_f1 = max(best_val_f1, val_metrics["f1_macro"])
            print(f"[train] epoch {epoch+1}/{epochs} loss={avg_loss:.4f} "
                  f"val_acc={val_metrics['accuracy']:.1f}% f1={val_metrics['f1_macro']:.4f} "
                  f"({elapsed:.0f}s)")
        else:
            print(f"[train] epoch {epoch+1}/{epochs} loss={avg_loss:.4f} ({elapsed:.0f}s)")

    # Save checkpoint
    save_path = os.path.join(checkpoint_dir, version)
    Path(save_path).mkdir(parents=True, exist_ok=True)
    model.save_pretrained(save_path)
    tokenizer.save_pretrained(save_path)
    print(f"[train] checkpoint saved: {save_path}")

    return {
        "version": version,
        "checkpoint_path": save_path,
        "val_accuracy": best_val_acc,
        "val_f1": best_val_f1,
        "training_samples_count": len(train_prompts),
        "epochs": epochs,
        "duration_s": round(time.time() - t0, 1),
    }
