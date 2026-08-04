from agents.usage import Usage
from fastapi.testclient import TestClient

from app.agent import ChattyContext, ChattyTurn
from app.api import create_app
from app.data.catalog import Catalog
from app.data.database import DATA_DIR
from app.data.models import (
    ClarifyReply,
    KnowledgeReply,
    RecommendationResponse,
    RecommendedProduct,
)


def _turn(client: TestClient, session_id: str, text: str):
    return client.post(
        f"/api/sessions/{session_id}/turns",
        json={"text": text},
    )


def test_http_returns_one_stable_shape_for_a_knowledge_answer(tmp_path) -> None:
    class FakeChatty:
        async def run(
            self, user_id: str, text: str, context: ChattyContext
        ) -> ChattyTurn:
            return ChattyTurn(
                reply=KnowledgeReply(
                    answer="默认使用平台合作快递，具体承运方以订单页为准。",
                ),
                understood_as="知识：快递公司",
                context=ChattyContext(said=[text], turns=1),
                turns_left=2,
                trace=["task_framing", "retrieve_knowledge", "evidence_validation"],
                usage=Usage(
                    requests=2,
                    input_tokens=300,
                    output_tokens=40,
                    total_tokens=340,
                ),
                latency_ms=1,
            )

    catalog = Catalog(tmp_path / "chatty.db", DATA_DIR)
    try:
        with TestClient(create_app(catalog=catalog, chatty=FakeChatty())) as client:
            session_id = client.post(
                "/api/sessions", json={"user_id": "user_active"}
            ).json()["session_id"]
            response = _turn(client, session_id, "你们用什么快递？")

        assert response.status_code == 200
        assert response.json() == {
            "kind": "answer",
            "answer": "默认使用平台合作快递，具体承运方以订单页为准。",
            "question": None,
            "products": [],
            "understood_as": "知识：快递公司",
            "latency_ms": 1,
            "turns_left": 2,
            "trace": ["task_framing", "retrieve_knowledge", "evidence_validation"],
            "usage": {
                "model_requests": 2,
                "input_tokens": 300,
                "output_tokens": 40,
                "total_tokens": 340,
            },
        }
    finally:
        catalog.close()


def test_http_preserves_answer_and_products_for_a_mixed_request(tmp_path) -> None:
    product = RecommendedProduct(
        product_id="p001",
        name="入门蓝牙耳机",
        category="耳机",
        price_cents=19_900,
        brand="Demo",
        stock=8,
        tags=["蓝牙"],
        low_stock=False,
        reason="符合 200 元预算",
        marketing_copy="轻松入手",
    )

    class FakeChatty:
        async def run(
            self, user_id: str, text: str, context: ChattyContext
        ) -> ChattyTurn:
            return ChattyTurn(
                reply=RecommendationResponse(
                    products=[product],
                    answer="该商品适用七天无理由退货，需保持完好。",
                ),
                understood_as="耳机 · ≤200 元 · 知识：七天无理由退货条件",
                context=ChattyContext(said=[text], turns=1),
                turns_left=2,
                trace=["task_framing", "retrieve_knowledge", "evidence_validation"],
                usage=Usage(),
                latency_ms=1,
            )

    catalog = Catalog(tmp_path / "chatty.db", DATA_DIR)
    try:
        with TestClient(create_app(catalog=catalog, chatty=FakeChatty())) as client:
            session_id = client.post(
                "/api/sessions", json={"user_id": "user_active"}
            ).json()["session_id"]
            response = _turn(
                client,
                session_id,
                "推荐 200 元耳机，顺便问问能否七天无理由退货",
            )

        payload = response.json()
        assert response.status_code == 200
        assert payload["kind"] == "recommend"
        assert payload["answer"] == "该商品适用七天无理由退货，需保持完好。"
        assert payload["question"] is None
        assert [item["product_id"] for item in payload["products"]] == ["p001"]
    finally:
        catalog.close()


def test_http_carries_clarification_context_into_the_next_turn(tmp_path) -> None:
    class FakeChatty:
        def __init__(self) -> None:
            self.contexts: list[ChattyContext] = []

        async def run(
            self, user_id: str, text: str, context: ChattyContext
        ) -> ChattyTurn:
            self.contexts.append(context)
            said = [*context.said, text]
            return ChattyTurn(
                reply=ClarifyReply(question="还需要什么？"),
                understood_as="耳机",
                context=ChattyContext(said=said, turns=context.turns + 1),
                turns_left=2 - context.turns,
                trace=["task_framing", "evidence_validation"],
                usage=Usage(),
                latency_ms=1,
            )

    catalog = Catalog(tmp_path / "chatty.db", DATA_DIR)
    fake_chatty = FakeChatty()
    try:
        with TestClient(create_app(catalog=catalog, chatty=fake_chatty)) as client:
            session_id = client.post(
                "/api/sessions", json={"user_id": "user_active"}
            ).json()["session_id"]
            assert _turn(client, session_id, "给我推荐耳机").status_code == 200
            assert _turn(client, session_id, "预算 200 元").status_code == 200

        assert fake_chatty.contexts == [
            ChattyContext(),
            ChattyContext(said=["给我推荐耳机"], turns=1),
        ]
    finally:
        catalog.close()
