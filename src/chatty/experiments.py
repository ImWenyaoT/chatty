from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from threading import Lock
from typing import Any

from chatty.models import ExperimentGroup


@dataclass
class GroupStats:
    recommendations: int = 0
    request_successes: int = 0
    request_failures: int = 0
    positive_outcomes: int = 0
    negative_outcomes: int = 0
    total_latency_ms: float = 0.0


@dataclass
class ExperimentMetrics:
    experiment_id: str = "ranking_strategy"
    _groups: dict[ExperimentGroup, GroupStats] = field(
        default_factory=lambda: {
            "control": GroupStats(),
            "treatment_personalized": GroupStats(),
        }
    )
    _lock: Lock = field(default_factory=Lock)

    def assign(self, user_id: str) -> ExperimentGroup:
        digest = hashlib.sha256(f"{user_id}:{self.experiment_id}".encode()).digest()
        return "control" if int.from_bytes(digest[:8]) % 2 == 0 else "treatment_personalized"

    def record_request(
        self,
        group: ExperimentGroup,
        *,
        success: bool,
        latency_ms: float,
    ) -> None:
        with self._lock:
            stats = self._groups[group]
            stats.recommendations += 1
            stats.total_latency_ms += latency_ms
            if success:
                stats.request_successes += 1
            else:
                stats.request_failures += 1

    def record_outcome(self, user_id: str, success: bool) -> ExperimentGroup:
        group = self.assign(user_id)
        with self._lock:
            stats = self._groups[group]
            if success:
                stats.positive_outcomes += 1
            else:
                stats.negative_outcomes += 1
        return group

    def experiment_snapshot(self) -> dict[str, Any]:
        with self._lock:
            groups = {name: self._group_payload(stats) for name, stats in self._groups.items()}
        return {
            "experiment_id": self.experiment_id,
            "allocation": {"control": 50, "treatment_personalized": 50},
            "groups": groups,
            "persistence": "in_memory",
        }

    def metrics_snapshot(self) -> dict[str, Any]:
        with self._lock:
            groups = {name: self._group_payload(stats) for name, stats in self._groups.items()}
            requests = sum(item.recommendations for item in self._groups.values())
            successes = sum(item.request_successes for item in self._groups.values())
            failures = sum(item.request_failures for item in self._groups.values())
            latency = sum(item.total_latency_ms for item in self._groups.values())
        return {
            "requests": requests,
            "successes": successes,
            "failures": failures,
            "success_rate": successes / requests if requests else 0.0,
            "average_latency_ms": latency / requests if requests else 0.0,
            "groups": groups,
        }

    @staticmethod
    def _group_payload(stats: GroupStats) -> dict[str, int | float]:
        return {
            "recommendations": stats.recommendations,
            "request_successes": stats.request_successes,
            "request_failures": stats.request_failures,
            "positive_outcomes": stats.positive_outcomes,
            "negative_outcomes": stats.negative_outcomes,
            "average_latency_ms": (
                stats.total_latency_ms / stats.recommendations if stats.recommendations else 0.0
            ),
        }
