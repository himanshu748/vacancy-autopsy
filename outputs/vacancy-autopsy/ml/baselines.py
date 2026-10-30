"""Small deterministic baselines; fit preprocessing only on training rows."""
from __future__ import annotations

import math
from typing import Any

from data import NUMERIC_FEATURES, SOURCE_TYPES, target


class Encoder:
    def __init__(self, train: list[dict[str, Any]]):
        if not train:
            raise ValueError("Training rows are required")
        self.centers: dict[str, float] = {}
        self.scales: dict[str, float] = {}
        for name in NUMERIC_FEATURES:
            observed = [row["features"][name] for row in train if row["features"][name] is not None]
            center = sum(observed) / len(observed) if observed else 0.0
            scale = math.sqrt(sum((value - center) ** 2 for value in observed) / len(observed)) if observed else 1.0
            self.centers[name] = center
            self.scales[name] = scale or 1.0

    def transform(self, rows: list[dict[str, Any]]) -> list[list[float]]:
        matrix = []
        for row in rows:
            values = [1.0]  # intercept
            for name in NUMERIC_FEATURES:
                value = row["features"][name]
                values.extend((0.0 if value is None else (value - self.centers[name]) / self.scales[name], float(value is None)))
            values.extend(float(row["features"]["source_type"] == source) for source in SOURCE_TYPES)
            matrix.append(values)
        return matrix


def sigmoid(value: float) -> float:
    if value >= 0:
        return 1.0 / (1.0 + math.exp(-value))
    exponent = math.exp(value)
    return exponent / (1.0 + exponent)


def logistic_scores(train: list[dict[str, Any]], test: list[dict[str, Any]]) -> list[float]:
    """L2 logistic regression, fixed full-batch gradient descent; no test tuning."""
    encoder = Encoder(train)
    matrix = encoder.transform(train)
    labels = [target(row) for row in train]
    weights = [0.0] * len(matrix[0])
    # Fixed before the experiment; intentionally no hyperparameter search.
    for _ in range(1200):
        gradients = [0.0] * len(weights)
        for values, label in zip(matrix, labels):
            error = sigmoid(sum(w * x for w, x in zip(weights, values))) - label
            for index, value in enumerate(values):
                gradients[index] += error * value
        for index in range(len(weights)):
            regularizer = 0.01 * weights[index] if index else 0.0
            weights[index] -= 0.05 * (gradients[index] / len(matrix) + regularizer)
    return [sigmoid(sum(w * x for w, x in zip(weights, values))) for values in encoder.transform(test)]


def age_scores(train: list[dict[str, Any]], test: list[dict[str, Any]]) -> list[float]:
    observed = sorted(row["features"]["listing_age_days"] for row in train if row["features"]["listing_age_days"] is not None)
    median = observed[len(observed) // 2] if observed else 0.0
    return [row["features"]["listing_age_days"] if row["features"]["listing_age_days"] is not None else median for row in test]
