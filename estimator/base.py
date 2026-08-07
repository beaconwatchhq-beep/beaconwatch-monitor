from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass
class Prediction:
    age_class: str
    age_confidence: float
    score: float
    score_low: float
    score_high: float
    warnings: list = field(default_factory=list)


class DeerEstimator(ABC):
    version: str

    @abstractmethod
    def predict(self, image_path: str) -> Prediction:
        ...
