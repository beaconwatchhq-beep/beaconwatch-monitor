"""Training pipeline scaffolding for a real age/score estimator.

Consumes the CSV produced by reports.export_training_csv() and fits a
BaselineTrainer: a deliberately simple nearest-centroid (age class) +
linear least-squares (score) model over the cheap features in
estimator/features.py. Its job is to prove the pipeline end-to-end and
give a non-random floor to compare future models against -- NOT to be
the final estimator. See README's "Training a real model" section for
when it's worth moving beyond this (more data -> better features ->
eventually a real CNN fine-tune, which needs new deps and is a separate
conversation).
"""

import argparse
import csv
import json
import os

import numpy as np

from estimator.base import Prediction
from estimator.features import FEATURE_NAMES, extract_features
from estimator.stub import AGE_CLASSES

AGE_ORDER = {cls: i for i, cls in enumerate(AGE_CLASSES)}


def load_dataset(csv_path: str, upload_dir: str = None) -> list[dict]:
    upload_dir = upload_dir or os.environ.get("DEER_UPLOAD_DIR", "./uploads")
    rows = []
    with open(csv_path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if not row.get("actual_age_class") or not row.get("actual_score"):
                continue
            photo_path = row["photo_path"]
            if not os.path.isabs(photo_path) and not os.path.exists(photo_path):
                candidate = os.path.join(upload_dir, os.path.basename(photo_path))
                if os.path.exists(candidate):
                    photo_path = candidate
            rows.append({
                "deer_id": row["deer_id"],
                "photo_path": photo_path,
                "actual_age_class": row["actual_age_class"],
                "actual_score": float(row["actual_score"]),
            })
    return rows


def train_val_split(rows: list[dict], val_frac: float = 0.2) -> tuple[list[dict], list[dict]]:
    ordered = sorted(rows, key=lambda r: r["deer_id"])
    n_val = max(1, int(len(ordered) * val_frac)) if ordered else 0
    val = ordered[:n_val]
    train = ordered[n_val:]
    return train, val


class TrainedModel:
    """Fitted BaselineTrainer parameters. JSON-serializable."""

    def __init__(self, feature_mean, feature_std, centroids, score_coef, score_intercept, score_residual_std, version="model-baseline"):
        self.feature_mean = np.asarray(feature_mean, dtype=np.float64)
        self.feature_std = np.asarray(feature_std, dtype=np.float64)
        self.centroids = {k: np.asarray(v, dtype=np.float64) for k, v in centroids.items()}
        self.score_coef = np.asarray(score_coef, dtype=np.float64)
        self.score_intercept = float(score_intercept)
        self.score_residual_std = float(score_residual_std)
        self.version = version

    def _normalize(self, features: np.ndarray) -> np.ndarray:
        std = np.where(self.feature_std == 0, 1.0, self.feature_std)
        return (features - self.feature_mean) / std

    def predict_features(self, features: np.ndarray) -> Prediction:
        norm = self._normalize(features)

        distances = {cls: np.linalg.norm(norm - centroid) for cls, centroid in self.centroids.items()}
        ranked = sorted(distances.items(), key=lambda kv: kv[1])
        age_class = ranked[0][0]

        if len(ranked) > 1 and ranked[1][1] > 0:
            confidence = float(np.clip(1.0 - ranked[0][1] / (ranked[0][1] + ranked[1][1]), 0.0, 1.0))
        else:
            confidence = 0.5

        score = float(norm @ self.score_coef + self.score_intercept)
        spread = self.score_residual_std
        score_low = score - spread
        score_high = score + spread

        return Prediction(
            age_class=age_class,
            age_confidence=round(confidence, 2),
            score=round(score, 1),
            score_low=round(score_low, 1),
            score_high=round(score_high, 1),
            warnings=["Baseline model: crude features, not biologically validated."],
        )

    def predict(self, image_path: str) -> Prediction:
        return self.predict_features(extract_features(image_path))

    def evaluate(self, val_rows: list[dict]) -> dict:
        if not val_rows:
            return {"n": 0, "exact_match_pct": None, "within_one_class_pct": None, "mae": None, "bias": None}

        exact = within_one = 0
        abs_errors = []
        signed_errors = []
        for row in val_rows:
            features = extract_features(row["photo_path"])
            pred = self.predict_features(features)

            pred_idx = AGE_ORDER.get(pred.age_class)
            actual_idx = AGE_ORDER.get(row["actual_age_class"])
            if pred_idx is not None and actual_idx is not None:
                if pred_idx == actual_idx:
                    exact += 1
                if abs(pred_idx - actual_idx) <= 1:
                    within_one += 1

            abs_errors.append(abs(pred.score - row["actual_score"]))
            signed_errors.append(pred.score - row["actual_score"])

        n = len(val_rows)
        return {
            "n": n,
            "exact_match_pct": round(100 * exact / n, 1),
            "within_one_class_pct": round(100 * within_one / n, 1),
            "mae": round(float(np.mean(abs_errors)), 2),
            "bias": round(float(np.mean(signed_errors)), 2),
        }

    def save(self, path: str) -> None:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        payload = {
            "version": self.version,
            "feature_names": FEATURE_NAMES,
            "feature_mean": self.feature_mean.tolist(),
            "feature_std": self.feature_std.tolist(),
            "centroids": {k: v.tolist() for k, v in self.centroids.items()},
            "score_coef": self.score_coef.tolist(),
            "score_intercept": self.score_intercept,
            "score_residual_std": self.score_residual_std,
        }
        with open(path, "w") as f:
            json.dump(payload, f, indent=2)

    @classmethod
    def load(cls, path: str) -> "TrainedModel":
        with open(path) as f:
            payload = json.load(f)
        return cls(
            feature_mean=payload["feature_mean"],
            feature_std=payload["feature_std"],
            centroids=payload["centroids"],
            score_coef=payload["score_coef"],
            score_intercept=payload["score_intercept"],
            score_residual_std=payload["score_residual_std"],
            version=payload.get("version", "model-baseline"),
        )


class BaselineTrainer:
    """Nearest-centroid age classifier + linear least-squares score regressor."""

    def fit(self, train_rows: list[dict], version: str = "model-baseline") -> TrainedModel:
        if not train_rows:
            raise ValueError("Cannot fit on an empty training set.")

        raw_features = np.array([extract_features(r["photo_path"]) for r in train_rows])
        feature_mean = raw_features.mean(axis=0)
        feature_std = raw_features.std(axis=0)
        std_safe = np.where(feature_std == 0, 1.0, feature_std)
        normalized = (raw_features - feature_mean) / std_safe

        centroids = {}
        for cls in AGE_CLASSES:
            idxs = [i for i, r in enumerate(train_rows) if r["actual_age_class"] == cls]
            if idxs:
                centroids[cls] = normalized[idxs].mean(axis=0)
        if not centroids:
            raise ValueError("No known age classes found in training data.")

        design = np.hstack([normalized, np.ones((len(train_rows), 1))])
        targets = np.array([r["actual_score"] for r in train_rows])
        coef_full, *_ = np.linalg.lstsq(design, targets, rcond=None)
        score_coef, score_intercept = coef_full[:-1], coef_full[-1]

        predicted = design @ coef_full
        residual_std = float(np.std(targets - predicted)) or 1.0

        return TrainedModel(
            feature_mean=feature_mean,
            feature_std=feature_std,
            centroids=centroids,
            score_coef=score_coef,
            score_intercept=score_intercept,
            score_residual_std=residual_std,
            version=version,
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", required=True, help="Training CSV from reports.export_training_csv()")
    parser.add_argument("--out", required=True, help="Output weights JSON path, e.g. weights/model.pt")
    parser.add_argument("--val-frac", type=float, default=0.2)
    parser.add_argument("--version", default=None, help="Model version tag; defaults to output filename")
    args = parser.parse_args()

    rows = load_dataset(args.csv)
    if not rows:
        raise SystemExit(f"No labeled rows found in {args.csv}")

    train_rows, val_rows = train_val_split(rows, args.val_frac)
    print(f"Loaded {len(rows)} labeled photos -> {len(train_rows)} train / {len(val_rows)} val")

    version = args.version or f"model-{os.path.basename(args.out)}"
    model = BaselineTrainer().fit(train_rows, version=version)
    model.save(args.out)
    print(f"Saved baseline model to {args.out} (version={version})")

    metrics = model.evaluate(val_rows)
    print("Validation metrics:")
    for k, v in metrics.items():
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
