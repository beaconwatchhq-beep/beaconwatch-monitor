"""Accuracy analysis + training-data export for harvested deer."""

import csv

import pandas as pd

import db

AGE_CLASSES = ["1.5", "2.5", "3.5", "4.5", "5.5+"]
AGE_ORDER = {cls: i for i, cls in enumerate(AGE_CLASSES)}


def harvested_dataframe() -> pd.DataFrame:
    rows = db.get_harvested_rows()
    return pd.DataFrame(rows)


def age_accuracy(df: pd.DataFrame) -> pd.DataFrame:
    """Exact-match % and within-one-class % of estimated vs actual age, by model_version."""
    if df.empty:
        return pd.DataFrame(columns=["model_version", "n", "exact_match_pct", "within_one_class_pct"])

    work = df.dropna(subset=["estimated_age_class", "actual_age_class"]).copy()
    work["est_idx"] = work["estimated_age_class"].map(AGE_ORDER)
    work["act_idx"] = work["actual_age_class"].map(AGE_ORDER)
    work["exact"] = work["est_idx"] == work["act_idx"]
    work["within_one"] = (work["est_idx"] - work["act_idx"]).abs() <= 1

    grouped = work.groupby("model_version").agg(
        n=("deer_id", "count"),
        exact_match_pct=("exact", "mean"),
        within_one_class_pct=("within_one", "mean"),
    ).reset_index()
    grouped["exact_match_pct"] = (grouped["exact_match_pct"] * 100).round(1)
    grouped["within_one_class_pct"] = (grouped["within_one_class_pct"] * 100).round(1)
    return grouped


def score_error(df: pd.DataFrame) -> pd.DataFrame:
    """MAE and signed bias (mean(estimated - actual)) of score, by model_version."""
    if df.empty:
        return pd.DataFrame(columns=["model_version", "n", "mae", "bias"])

    work = df.dropna(subset=["estimated_score", "actual_score"]).copy()
    work["abs_error"] = (work["estimated_score"] - work["actual_score"]).abs()
    work["signed_error"] = work["estimated_score"] - work["actual_score"]

    grouped = work.groupby("model_version").agg(
        n=("deer_id", "count"),
        mae=("abs_error", "mean"),
        bias=("signed_error", "mean"),
    ).reset_index()
    grouped["mae"] = grouped["mae"].round(2)
    grouped["bias"] = grouped["bias"].round(2)
    return grouped


def export_training_csv(path: str) -> str:
    """Write photo_path + actual labels for every harvested deer. Returns the path."""
    rows = db.get_harvested_rows()
    fields = [
        "deer_id", "photo_path", "actual_age_class", "actual_age_method",
        "actual_score", "actual_score_method",
    ]
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k) for k in fields})
    return path
