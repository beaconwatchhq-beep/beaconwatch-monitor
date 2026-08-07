import os

from estimator.base import DeerEstimator, Prediction

DEFAULT_WEIGHTS_PATH = "./weights/model.pt"


class ModelEstimator(DeerEstimator):
    """Real estimator. Loads weights on init; refuses to silently fall back."""

    version = "model-unset"

    def __init__(self):
        weights_path = os.environ.get("DEER_MODEL_WEIGHTS", DEFAULT_WEIGHTS_PATH)
        if not os.path.isfile(weights_path):
            raise RuntimeError(
                f"Model weights not found at '{weights_path}'. "
                "Set DEER_MODEL_WEIGHTS to a valid weights file, or set "
                "DEER_MODEL=stub for development."
            )
        self.weights_path = weights_path
        self.version = f"model-{os.path.basename(weights_path)}"

    def predict(self, image_path: str) -> Prediction:
        raise NotImplementedError(
            "ModelEstimator.predict is not implemented yet. "
            "Use DEER_MODEL=stub during development."
        )
