import hashlib
import random

from estimator.base import DeerEstimator, Prediction

AGE_CLASSES = ["1.5", "2.5", "3.5", "4.5", "5.5+"]
AGE_WEIGHTS = [0.25, 0.30, 0.22, 0.13, 0.10]


class StubEstimator(DeerEstimator):
    """Deterministic fake estimator seeded off the uploaded file's own bytes."""

    version = "stub-v1"

    def predict(self, image_path: str) -> Prediction:
        with open(image_path, "rb") as f:
            digest = hashlib.sha256(f.read()).hexdigest()
        rng = random.Random(int(digest, 16))

        age_class = rng.choices(AGE_CLASSES, weights=AGE_WEIGHTS, k=1)[0]
        age_confidence = round(rng.uniform(0.4, 0.95), 2)

        base_score = {
            "1.5": rng.uniform(70, 100),
            "2.5": rng.uniform(90, 125),
            "3.5": rng.uniform(110, 145),
            "4.5": rng.uniform(125, 160),
            "5.5+": rng.uniform(135, 175),
        }[age_class]
        score = round(base_score, 1)
        spread = round(score * rng.uniform(0.08, 0.15), 1)
        score_low = round(max(0.0, score - spread), 1)
        score_high = round(score + spread, 1)

        warnings = []
        if age_confidence < 0.5:
            warnings.append("Low confidence estimate; consider a clearer photo.")

        return Prediction(
            age_class=age_class,
            age_confidence=age_confidence,
            score=score,
            score_low=score_low,
            score_high=score_high,
            warnings=warnings,
        )
