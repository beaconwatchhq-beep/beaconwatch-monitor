import os

from estimator.base import DeerEstimator, Prediction
from estimator.features import extract_features

DEFAULT_WEIGHTS_PATH = "./weights/model.pt"


class ModelEstimator(DeerEstimator):
    """Real estimator. Loads weights on init; refuses to silently fall back.

    Currently backed by whatever train.py produced (a JSON parameter file
    for a nearest-centroid + linear regression baseline -- see train.py's
    module docstring). This is plumbing, not a biologically validated
    aging model; treat predictions accordingly until a real computer-vision
    model replaces it.
    """

    version = "model-unset"

    def __init__(self):
        weights_path = os.environ.get("DEER_MODEL_WEIGHTS", DEFAULT_WEIGHTS_PATH)
        if not os.path.isfile(weights_path):
            raise RuntimeError(
                f"Model weights not found at '{weights_path}'. "
                "Train one with train.py, set DEER_MODEL_WEIGHTS to a valid "
                "weights file, or set DEER_MODEL=stub for development."
            )
        self.weights_path = weights_path

        from train import TrainedModel  # local import: keeps train.py's deps out of the app's hot path

        self._model = TrainedModel.load(weights_path)
        self.version = self._model.version

    def predict(self, image_path: str) -> Prediction:
        features = extract_features(image_path)
        return self._model.predict_features(features)
