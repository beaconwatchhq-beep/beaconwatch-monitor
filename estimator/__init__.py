import os

from estimator.base import DeerEstimator, Prediction

__all__ = ["DeerEstimator", "Prediction", "get_estimator"]


def get_estimator() -> DeerEstimator:
    mode = os.environ.get("DEER_MODEL", "stub").lower()
    if mode == "stub":
        from estimator.stub import StubEstimator

        return StubEstimator()
    if mode == "model":
        from estimator.model import ModelEstimator

        return ModelEstimator()
    raise ValueError(f"Unknown DEER_MODEL value: '{mode}'. Use 'stub' or 'model'.")
