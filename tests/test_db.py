import sqlite3

import pytest

import db


@pytest.fixture
def db_path(tmp_path):
    path = str(tmp_path / "test.db")
    db.init_db(path)
    return path


def make_record(deer_id="abc123def456", sha="a" * 64):
    return {
        "deer_id": deer_id,
        "photo_path": f"/uploads/{deer_id}.jpg",
        "photo_sha256": sha,
        "latitude": 40.0,
        "longitude": -85.0,
        "exif_datetime": "2024:11:01 07:30:00",
        "estimated_age_class": "3.5",
        "estimated_age_confidence": 0.72,
        "estimated_score": 135.5,
        "estimated_score_low": 120.0,
        "estimated_score_high": 150.0,
        "model_version": "stub-v1",
        "uploader_label": "north field",
    }


def test_init_db_is_idempotent(db_path):
    db.init_db(db_path)  # calling twice should not error
    with db.get_connection(db_path) as conn:
        cols = {row["name"] for row in conn.execute("PRAGMA table_info(deer)")}
    assert "deer_id" in cols
    assert "harvest_status" in cols

    with db.get_connection(db_path) as conn:
        indexes = {row["name"] for row in conn.execute("PRAGMA index_list(deer)")}
    assert "idx_deer_harvest_status" in indexes
    assert "idx_deer_model_version" in indexes


def test_insert_and_get_deer(db_path):
    record = make_record()
    db.insert_deer(record, db_path)
    fetched = db.get_deer(record["deer_id"], db_path)
    assert fetched is not None
    assert fetched["estimated_age_class"] == "3.5"
    assert fetched["harvest_status"] == 0


def test_duplicate_photo_hash_rejected(db_path):
    db.insert_deer(make_record(deer_id="deer0000001", sha="b" * 64), db_path)
    with pytest.raises(sqlite3.IntegrityError):
        db.insert_deer(make_record(deer_id="deer0000002", sha="b" * 64), db_path)


def test_get_deer_by_sha256(db_path):
    record = make_record(sha="c" * 64)
    db.insert_deer(record, db_path)
    found = db.get_deer_by_sha256("c" * 64, db_path)
    assert found["deer_id"] == record["deer_id"]


def test_mark_harvested_updates_fields(db_path):
    record = make_record()
    db.insert_deer(record, db_path)

    db.mark_harvested(
        deer_id=record["deer_id"],
        harvest_date="2024-11-15",
        actual_age_class="4.5",
        actual_age_method="tooth wear",
        actual_score=142.0,
        actual_score_method="B&C gross",
        notes="clean shot",
        db_path=db_path,
    )

    updated = db.get_deer(record["deer_id"], db_path)
    assert updated["harvest_status"] == 1
    assert updated["actual_age_class"] == "4.5"
    assert updated["actual_score"] == 142.0
    assert updated["notes"] == "clean shot"
    # original AI estimate untouched
    assert updated["estimated_age_class"] == "3.5"


def test_get_harvested_rows_only_returns_harvested(db_path):
    r1 = make_record(deer_id="deer0000003", sha="d" * 64)
    r2 = make_record(deer_id="deer0000004", sha="e" * 64)
    db.insert_deer(r1, db_path)
    db.insert_deer(r2, db_path)
    db.mark_harvested(
        deer_id=r1["deer_id"],
        harvest_date="2024-11-15",
        actual_age_class="3.5",
        actual_age_method="cementum",
        actual_score=130.0,
        actual_score_method="green",
        db_path=db_path,
    )
    harvested = db.get_harvested_rows(db_path)
    assert len(harvested) == 1
    assert harvested[0]["deer_id"] == r1["deer_id"]
