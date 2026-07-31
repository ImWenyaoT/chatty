"""HTTP 层的测试，全程离线。

能离线跑是因为 `create_app` 收 catalog 和 provider 两个注入口——那是这一层唯一
需要的 seam。没有它就只能连真实 API，也就等于没有测试。

这里测的是 HTTP 层自己的职责：会话跨请求存活、失败不污染会话、领域错误码传得出去。
业务事实（价格、库存、证据校验）在 Harness 那边测过了，不在这里重复。
"""

from __future__ import annotations

import json
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from chatty.api import MAX_TURNS, create_app
from chatty.catalog import Catalog
from chatty.model_provider import StaticModelProvider
from tests.test_agent import MessageStep, ScriptedModel, ToolStep, successful_script


def _clarify(question: str) -> MessageStep:
    return MessageStep(
        f"clarify-{question}",
        json.dumps({"action": "clarify", "question": question}, ensure_ascii=False),
    )


# parse_need 每轮调一次，答案固定成「耳机」，让解析结果可预测
_PARSED = '{"category": "耳机", "max_yuan": 3000}'


def _client(catalog: Catalog, script: list, replies: list[str] | None = None) -> TestClient:
    provider = StaticModelProvider(
        ScriptedModel(script), model_id="scripted-model", replies=replies or [_PARSED]
    )
    return TestClient(create_app(catalog=catalog, provider=provider))


@pytest.fixture
def client(catalog: Catalog) -> Iterator[TestClient]:
    with _client(catalog, successful_script()) as c:
        yield c


def test_catalog_endpoint_feeds_the_frontend_its_starting_state(client: TestClient) -> None:
    body = client.get("/api/catalog").json()
    assert "耳机" in body["categories"]
    assert body["categories"] == sorted(set(body["categories"]))
    assert "user_active" in body["users"]
    assert body["product_count"] > 0
    # 印出来的模型必须是实际推理用的那个
    assert body["model_id"] == "scripted-model"


def test_a_recommendation_comes_back_with_fields_from_sqlite(client: TestClient) -> None:
    session_id = client.post("/api/sessions", json={"user_id": "user_active"}).json()["session_id"]
    body = client.post(f"/api/sessions/{session_id}/turns", json={"text": "想买个降噪耳机"}).json()

    assert body["kind"] == "recommend"
    assert body["understood_as"] == "耳机 · ≤3000 元"
    assert body["products"]
    product = body["products"][0]
    # 价格来自 SQLite 重查，不是模型说的
    assert product["product_id"] == "P003"
    assert product["price_cents"] == 189900
    assert product["stock"] > 0


def test_an_unknown_user_is_rejected(client: TestClient) -> None:
    assert client.post("/api/sessions", json={"user_id": "user_nope"}).status_code == 422


def test_an_unknown_session_is_not_found(client: TestClient) -> None:
    response = client.post("/api/sessions/session_nope/turns", json={"text": "耳机"})
    assert response.status_code == 404
    assert response.json()["detail"] == "session_not_found"


def test_a_clarification_survives_into_the_next_request(catalog: Catalog) -> None:
    """会话要跨请求存活——HTTP 层存在的全部理由就是这个。"""
    script = [_clarify("你想看哪一类商品？"), *successful_script()]
    with _client(catalog, script, replies=[_PARSED]) as client:
        session_id = client.post("/api/sessions", json={"user_id": "user_active"}).json()[
            "session_id"
        ]
        first = client.post(f"/api/sessions/{session_id}/turns", json={"text": "随便看看"}).json()
        assert first["kind"] == "clarify"
        assert first["question"] == "你想看哪一类商品？"
        assert first["turns_left"] == MAX_TURNS - 1

        second = client.post(f"/api/sessions/{session_id}/turns", json={"text": "耳机"}).json()
        assert second["kind"] == "recommend"
        assert second["products"]


def test_running_out_of_turns_is_told_apart_from_a_normal_clarification(
    catalog: Catalog,
) -> None:
    """轮次用完还在反问时前端该提示重开，而不是让人继续答。"""
    script = [_clarify(f"问题{i}") for i in range(MAX_TURNS)]
    with _client(catalog, script) as client:
        session_id = client.post("/api/sessions", json={"user_id": "user_active"}).json()[
            "session_id"
        ]
        kinds = [
            client.post(f"/api/sessions/{session_id}/turns", json={"text": "嗯"}).json()["kind"]
            for _ in range(MAX_TURNS)
        ]
        assert kinds == ["clarify"] * (MAX_TURNS - 1) + ["exhausted"]

        # 再问就该被拒，而不是默默多跑一轮
        overflow = client.post(f"/api/sessions/{session_id}/turns", json={"text": "还要"})
        assert overflow.status_code == 409
        assert overflow.json()["detail"] == "conversation_exhausted"


def test_a_domain_failure_keeps_its_error_code(catalog: Catalog) -> None:
    """稳定错误码要传到前端——它比 500 有用，前端能按码给不同的解释。"""
    script = successful_script()
    del script[0]  # 少调一个工具，Harness 该拦下来
    with _client(catalog, script) as client:
        session_id = client.post("/api/sessions", json={"user_id": "user_active"}).json()[
            "session_id"
        ]
        response = client.post(f"/api/sessions/{session_id}/turns", json={"text": "耳机"})

    assert response.status_code == 422
    assert response.json()["detail"] == "required_tools_not_used"


def test_a_failed_turn_does_not_poison_the_session(catalog: Catalog) -> None:
    """跑挂的那句话不该留在 said 里，否则下一轮解析会带上它。"""
    broken = successful_script()
    del broken[0]
    script = [*broken, *successful_script()]
    with _client(catalog, script) as client:
        session_id = client.post("/api/sessions", json={"user_id": "user_active"}).json()[
            "session_id"
        ]
        failed = client.post(f"/api/sessions/{session_id}/turns", json={"text": "会挂的一句"})
        assert failed.status_code == 422

        # 会话还在，轮次没被消耗
        recovered = client.post(f"/api/sessions/{session_id}/turns", json={"text": "耳机"}).json()
        assert recovered["kind"] == "recommend"
        assert recovered["turns_left"] == MAX_TURNS - 1


def test_empty_input_is_rejected_before_it_reaches_the_model(client: TestClient) -> None:
    session_id = client.post("/api/sessions", json={"user_id": "user_active"}).json()["session_id"]
    assert client.post(f"/api/sessions/{session_id}/turns", json={"text": ""}).status_code == 422


def test_sessions_do_not_see_each_other(catalog: Catalog) -> None:
    script = [*successful_script(), *successful_script()]
    with _client(catalog, script) as client:
        # 同一个身份开两个会话：要验的是会话之间互不影响，不是身份差异
        first = client.post("/api/sessions", json={"user_id": "user_active"}).json()["session_id"]
        second = client.post("/api/sessions", json={"user_id": "user_active"}).json()["session_id"]
        assert first != second

        client.post(f"/api/sessions/{first}/turns", json={"text": "耳机"})
        body = client.post(f"/api/sessions/{second}/turns", json={"text": "耳机"}).json()
        # 第二个会话是全新的，轮次没被第一个消耗
        assert body["turns_left"] == MAX_TURNS - 1


def test_the_tool_evidence_still_gates_the_http_path(catalog: Catalog) -> None:
    """HTTP 层没有绕开 Harness：证据不全一样会被拦。"""
    script = successful_script()
    script[3] = ToolStep(
        "call-4",
        "retrieve_knowledge",
        {"query": "不存在的知识关键词", "categories": [], "product_ids": [], "limit": 3},
    )
    with _client(catalog, script) as client:
        session_id = client.post("/api/sessions", json={"user_id": "user_active"}).json()[
            "session_id"
        ]
        response = client.post(f"/api/sessions/{session_id}/turns", json={"text": "耳机"})

    assert response.status_code == 422
    assert response.json()["detail"] == "knowledge_not_retrieved"
