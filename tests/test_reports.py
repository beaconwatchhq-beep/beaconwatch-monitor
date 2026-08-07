import pandas as pd

import reports


def make_df():
    return pd.DataFrame([
        {
            "deer_id": "d1", "model_version": "stub-v1",
            "estimated_age_class": "3.5", "actual_age_class": "3.5",
            "estimated_score": 130.0, "actual_score": 125.0,
        },
        {
            "deer_id": "d2", "model_version": "stub-v1",
            "estimated_age_class": "2.5", "actual_age_class": "3.5",
            "estimated_score": 110.0, "actual_score": 120.0,
        },
        {
            "deer_id": "d3", "model_version": "stub-v1",
            "estimated_age_class": "1.5", "actual_age_class": "4.5",
            "estimated_score": 90.0, "actual_score": 150.0,
        },
        {
            "deer_id": "d4", "model_version": "model-v2",
            "estimated_age_class": "4.5", "actual_age_class": "4.5",
            "estimated_score": 140.0, "actual_score": 140.0,
        },
    ])


def test_age_accuracy_exact_and_within_one():
    df = make_df()
    result = reports.age_accuracy(df).set_index("model_version")

    stub = result.loc["stub-v1"]
    assert stub["n"] == 3
    # exact match: only d1 -> 1/3
    assert stub["exact_match_pct"] == pytest_approx(100 / 3)
    # within one class: d1 (0), d2 (1) match; d3 (3.5 vs 1.5.. off by 3) does not -> 2/3
    assert stub["within_one_class_pct"] == pytest_approx(200 / 3)

    model_v2 = result.loc["model-v2"]
    assert model_v2["n"] == 1
    assert model_v2["exact_match_pct"] == 100.0
    assert model_v2["within_one_class_pct"] == 100.0


def test_score_error_mae_and_bias():
    df = make_df()
    result = reports.score_error(df).set_index("model_version")

    stub = result.loc["stub-v1"]
    # errors: 130-125=5, 110-120=-10, 90-150=-60
    expected_mae = (5 + 10 + 60) / 3
    expected_bias = (5 - 10 - 60) / 3
    assert stub["mae"] == pytest_approx(expected_mae)
    assert stub["bias"] == pytest_approx(expected_bias)


def test_age_accuracy_empty_df():
    empty = pd.DataFrame()
    result = reports.age_accuracy(empty)
    assert result.empty


def test_score_error_empty_df():
    empty = pd.DataFrame()
    result = reports.score_error(empty)
    assert result.empty


def pytest_approx(value):
    import pytest as _pytest
    return _pytest.approx(round(value, 2), abs=0.05)
