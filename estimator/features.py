"""Cheap Pillow+numpy image features shared by train.py and ModelEstimator.

This is deliberately NOT a claim of biological accuracy. It's plumbing: a
concrete, testable starting point so the training pipeline has something
real to fit against. Train-time and serve-time feature extraction share
this module so they can never drift apart.
"""

import numpy as np
from PIL import Image

FEATURE_NAMES = [
    "aspect_ratio",
    "mean_r", "mean_g", "mean_b",
    "brightness_std",
    "edge_density",
]


def extract_features(image_path: str) -> np.ndarray:
    with Image.open(image_path) as img:
        img = img.convert("RGB")
        width, height = img.size
        arr = np.asarray(img, dtype=np.float64)

    aspect_ratio = width / height if height else 0.0
    mean_r, mean_g, mean_b = arr[..., 0].mean(), arr[..., 1].mean(), arr[..., 2].mean()

    gray = arr.mean(axis=2)
    brightness_std = gray.std()

    grad_y, grad_x = np.gradient(gray)
    edge_density = np.sqrt(grad_x ** 2 + grad_y ** 2).mean()

    return np.array(
        [aspect_ratio, mean_r, mean_g, mean_b, brightness_std, edge_density],
        dtype=np.float64,
    )
