from chatty.experiments import ExperimentMetrics


def test_assignment_is_stable_and_uses_both_groups() -> None:
    metrics = ExperimentMetrics()
    assert metrics.assign("same-user") == metrics.assign("same-user")
    groups = {metrics.assign(f"user-{index}") for index in range(100)}
    assert groups == {"control", "treatment_personalized"}


def test_request_outcome_and_metrics_are_aggregated() -> None:
    metrics = ExperimentMetrics()
    group = metrics.assign("user-1")
    metrics.record_request(group, success=True, latency_ms=20)
    metrics.record_request(group, success=False, latency_ms=40)
    recorded_group = metrics.record_outcome("user-1", True)

    assert recorded_group == group
    snapshot = metrics.metrics_snapshot()
    assert snapshot["requests"] == 2
    assert snapshot["successes"] == 1
    assert snapshot["failures"] == 1
    assert snapshot["average_latency_ms"] == 30
    assert snapshot["groups"][group]["positive_outcomes"] == 1
