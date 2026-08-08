import os

import pytest

from estimator.base import DeerEstimator, Prediction
from estimator.model import ModelEstimator
from estimator.stub import AGE_CLASSES, StubEstimator


@pytest.fixture
def sample_image(tmp_path):
    path = tmp_path / "deer.jpg"
    path.write_bytes(b"\xff\xd8\xff" + b"fake jpeg bytes for hashing" * 10)
    return str(path)


def test_stub_estimator_is_deterministic(sample_image):
    estimator = StubEstimator()
    p1 = estimator.predict(sample_image)
    p2 = estimator.predict(sample_image)
    assert p1 == p2


def test_stub_estimator_returns_valid_age_class(sample_image):
    estimator = StubEstimator()
    prediction = estimator.predict(sample_image)
    assert prediction.age_class in AGE_CLASSES
    assert 0.0 <= prediction.age_confidence <= 1.0
    assert prediction.score_low <= prediction.score <= prediction.score_high


def test_stub_estimator_different_files_can_differ(tmp_path):
    estimator = StubEstimator()
    p1 = tmp_path / "a.jpg"
    p2 = tmp_path / "b.jpg"
    p1.write_bytes(b"\xff\xd8\xff aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    p2.write_bytes(b"\xff\xd8\xff bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    pred1 = estimator.predict(str(p1))
    pred2 = estimator.predict(str(p2))
    assert isinstance(pred1, Prediction)
    assert isinstance(pred2, Prediction)


def test_estimator_interface_contract():
    assert issubclass(StubEstimator, DeerEstimator)
    assert hasattr(StubEstimator, "version")
    assert StubEstimator.version == "stub-v1"


def test_model_estimator_raises_when_weights_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("DEER_MODEL_WEIGHTS", str(tmp_path / "does_not_exist.pt"))
    with pytest.raises(RuntimeError, match="weights not found"):
        ModelEstimator()
