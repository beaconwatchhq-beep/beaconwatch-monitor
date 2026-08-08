import csv
import os

import numpy as np
from PIL import Image

import train
from estimator.stub import AGE_CLASSES


def make_image(path, color):
    Image.new("RGB", (40, 30), color=color).save(path)


def make_csv(path, rows):
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "deer_id", "photo_path", "actual_age_class", "actual_age_method",
            "actual_score", "actual_score_method",
        ])
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def make_sample_rows(tmp_path, n=10):
    rows = []
    for i in range(n):
        img_path = tmp_path / f"deer{i}.jpg"
        color = (20 * i % 255, 10 * i % 255, 5 * i % 255)
        make_image(str(img_path), color)
        rows.append({
            "deer_id": f"deer{i:03d}",
            "photo_path": str(img_path),
            "actual_age_class": AGE_CLASSES[i % len(AGE_CLASSES)],
            "actual_age_method": "tooth wear",
            "actual_score": 100.0 + i,
            "actual_score_method": "green",
        })
    return rows


def test_load_dataset_parses_csv(tmp_path):
    rows = make_sample_rows(tmp_path, n=3)
    csv_path = tmp_path / "training.csv"
    make_csv(str(csv_path), rows)

    loaded = train.load_dataset(str(csv_path))
    assert len(loaded) == 3
    assert loaded[0]["actual_age_class"] in AGE_CLASSES
    assert isinstance(loaded[0]["actual_score"], float)


def test_load_dataset_skips_unlabeled_rows(tmp_path):
    rows = make_sample_rows(tmp_path, n=2)
    rows.append({
        "deer_id": "deer999", "photo_path": str(tmp_path / "deer999.jpg"),
        "actual_age_class": "", "actual_age_method": "",
        "actual_score": "", "actual_score_method": "",
    })
    csv_path = tmp_path / "training.csv"
    make_csv(str(csv_path), rows)

    loaded = train.load_dataset(str(csv_path))
    assert len(loaded) == 2


def test_train_val_split_deterministic_and_non_overlapping(tmp_path):
    rows = make_sample_rows(tmp_path, n=10)
    tr1, val1 = train.train_val_split(rows, val_frac=0.3)
    tr2, val2 = train.train_val_split(rows, val_frac=0.3)

    assert [r["deer_id"] for r in tr1] == [r["deer_id"] for r in tr2]
    assert [r["deer_id"] for r in val1] == [r["deer_id"] for r in val2]

    train_ids = {r["deer_id"] for r in tr1}
    val_ids = {r["deer_id"] for r in val1}
    assert train_ids.isdisjoint(val_ids)
    assert len(train_ids) + len(val_ids) == len(rows)


def test_baseline_trainer_fit_and_evaluate_end_to_end(tmp_path):
    rows = make_sample_rows(tmp_path, n=12)
    train_rows, val_rows = train.train_val_split(rows, val_frac=0.25)

    model = train.BaselineTrainer().fit(train_rows, version="model-test")
    assert model.version == "model-test"

    metrics = model.evaluate(val_rows)
    assert metrics["n"] == len(val_rows)
    assert 0.0 <= metrics["exact_match_pct"] <= 100.0
    assert 0.0 <= metrics["within_one_class_pct"] <= 100.0
    assert metrics["mae"] >= 0.0
    assert isinstance(metrics["bias"], float)


def test_trained_model_save_and_load_roundtrip(tmp_path):
    rows = make_sample_rows(tmp_path, n=8)
    train_rows, _ = train.train_val_split(rows, val_frac=0.25)
    model = train.BaselineTrainer().fit(train_rows, version="model-roundtrip")

    weights_path = tmp_path / "weights" / "model.pt"
    model.save(str(weights_path))
    assert os.path.isfile(weights_path)

    loaded = train.TrainedModel.load(str(weights_path))
    assert loaded.version == "model-roundtrip"

    pred = loaded.predict(train_rows[0]["photo_path"])
    assert pred.age_class in AGE_CLASSES
    assert pred.score_low <= pred.score <= pred.score_high
