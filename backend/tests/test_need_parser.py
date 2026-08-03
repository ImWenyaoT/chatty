import pytest

from app.need_parser import NeedParseError, describe, parse_need


@pytest.mark.asyncio
async def test_single_price_is_an_upper_bound() -> None:
    async def complete(_: str, __: str | None) -> str:
        return '{"category":"耳机","min_yuan":null,"max_yuan":200}'

    context = await parse_need(complete, "我要一个 200 元的蓝牙耳机", ["耳机"])

    assert context.preferred_categories == ["耳机"]
    assert context.min_price_cents is None
    assert context.max_price_cents == 20_000
    assert describe(context) == "耳机 · ≤200 元"


@pytest.mark.asyncio
async def test_invalid_model_output_is_an_explicit_failure() -> None:
    async def complete(_: str, __: str | None) -> str:
        return "无法解析"

    with pytest.raises(NeedParseError, match="missing_need_json"):
        await parse_need(complete, "随便看看", ["耳机"])
