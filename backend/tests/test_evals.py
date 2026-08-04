import pytest

from app.data.models import KnowledgeReply, RecommendationResponse
from app.evals.agent import AgentCase, answer_contains, case_succeeds, reply_action
from app.evals.retrieval import main as run_retrieval_eval


def test_retrieval_eval_exits_nonzero_when_hit_rate_regresses(monkeypatch) -> None:
    class EmptyCatalog:
        def retrieve_knowledge(self, **kwargs):
            return []

        def close(self) -> None:
            pass

    monkeypatch.setattr("app.evals.retrieval.Catalog", EmptyCatalog)

    with pytest.raises(SystemExit) as caught:
        run_retrieval_eval()

    assert caught.value.code == 1


def test_knowledge_reply_is_a_valid_answer_outcome() -> None:
    assert reply_action(KnowledgeReply(answer="合作快递配送")) == "answer"


def test_knowledge_answer_must_contain_case_facts() -> None:
    reply = KnowledgeReply(answer="请查看帮助中心。")

    assert not answer_contains(reply, ("合作快递", "订单"))


def test_agent_eval_rejects_an_empty_recommendation() -> None:
    case = AgentCase(
        name="empty recommendation",
        user_id="user_budget",
        user_text="推荐耳机",
        expected_action="recommend",
    )
    reply = RecommendationResponse(products=[])

    assert not case_succeeds(case, reply, {})
