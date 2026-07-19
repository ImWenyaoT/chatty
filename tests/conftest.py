import pytest


def pytest_addoption(parser) -> None:
    parser.addoption(
        "--run-deepseek",
        action="store_true",
        default=False,
        help="run the opt-in real DeepSeek contract smoke",
    )


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if config.getoption("--run-deepseek"):
        return
    skip_contract = pytest.mark.skip(reason="pass --run-deepseek to run the real provider contract")
    for item in items:
        if "test_deepseek_contract.py" in item.nodeid:
            item.add_marker(skip_contract)
