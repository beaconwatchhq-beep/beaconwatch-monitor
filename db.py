"""SQLite schema and all SQL for the deer aging app. No raw SQL elsewhere."""

import os
import sqlite3
from contextlib import contextmanager

DB_PATH = os.environ.get("DEER_DB_PATH", "./deer.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS deer (
    deer_id TEXT PRIMARY KEY,
    photo_path TEXT NOT NULL,
    photo_sha256 TEXT UNIQUE,
    latitude REAL,
    longitude REAL,
    exif_datetime TEXT,
    estimated_age_class TEXT,
    estimated_age_confidence REAL,
    estimated_score REAL,
    estimated_score_low REAL,
    estimated_score_high REAL,
    model_version TEXT NOT NULL,
    upload_date TEXT DEFAULT (datetime('now')),
    uploader_label TEXT,
    harvest_status INTEGER DEFAULT 0,
    harvest_date TEXT,
    actual_age_class TEXT,
    actual_age_method TEXT,
    actual_score REAL,
    actual_score_method TEXT,
    notes TEXT
);
"""

INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_deer_harvest_status ON deer(harvest_status);",
    "CREATE INDEX IF NOT EXISTS idx_deer_model_version ON deer(model_version);",
]


@contextmanager
def get_connection(db_path: str = None):
    """Open a fresh connection per operation. Never reuse across Streamlit reruns."""
    conn = sqlite3.connect(db_path or DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db(db_path: str = None):
    with get_connection(db_path) as conn:
        conn.execute(SCHEMA)
        for stmt in INDEXES:
            conn.execute(stmt)


def insert_deer(record: dict, db_path: str = None) -> None:
    """Insert a new deer row. Raises sqlite3.IntegrityError on duplicate photo_sha256."""
    columns = [
        "deer_id", "photo_path", "photo_sha256", "latitude", "longitude",
        "exif_datetime", "estimated_age_class", "estimated_age_confidence",
        "estimated_score", "estimated_score_low", "estimated_score_high",
        "model_version", "uploader_label",
    ]
    values = [record.get(col) for col in columns]
    placeholders = ", ".join("?" for _ in columns)
    sql = f"INSERT INTO deer ({', '.join(columns)}) VALUES ({placeholders})"
    with get_connection(db_path) as conn:
        conn.execute(sql, values)


def get_deer(deer_id: str, db_path: str = None) -> dict | None:
    with get_connection(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM deer WHERE deer_id = ?", (deer_id,)
        ).fetchone()
        return dict(row) if row else None


def get_deer_by_sha256(photo_sha256: str, db_path: str = None) -> dict | None:
    with get_connection(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM deer WHERE photo_sha256 = ?", (photo_sha256,)
        ).fetchone()
        return dict(row) if row else None


def mark_harvested(
    deer_id: str,
    harvest_date: str,
    actual_age_class: str,
    actual_age_method: str,
    actual_score: float,
    actual_score_method: str,
    notes: str = None,
    db_path: str = None,
) -> None:
    with get_connection(db_path) as conn:
        conn.execute(
            """
            UPDATE deer
            SET harvest_status = 1,
                harvest_date = ?,
                actual_age_class = ?,
                actual_age_method = ?,
                actual_score = ?,
                actual_score_method = ?,
                notes = ?
            WHERE deer_id = ?
            """,
            (
                harvest_date,
                actual_age_class,
                actual_age_method,
                actual_score,
                actual_score_method,
                notes,
                deer_id,
            ),
        )


def get_harvested_rows(db_path: str = None) -> list[dict]:
    with get_connection(db_path) as conn:
        rows = conn.execute(
            "SELECT * FROM deer WHERE harvest_status = 1"
        ).fetchall()
        return [dict(r) for r in rows]
