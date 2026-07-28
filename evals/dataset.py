"""评估任务数据集。

对应《深入理解 AI Agent》第 6.3 节"评估任务数据集的设计"。

设计上落实了教材的四条原则：

1. **难度层次化**（GAIA 三级）：L1 基础工具使用 / L2 多约束权衡 / L3 边界与陷阱。
   分层的价值在于诊断——L1 失败说明工具调用有问题，L3 失败说明抗干扰能力弱。
2. **参数化模板**（AndroidWorld）：任务不是写死的文本，而是"画像 + 上下文覆盖"的组合，
   同一个模板换参数就能生成新实例，既防记忆也便于做对比实验。
3. **陷阱任务**（τ²-bench）：故意构造 Agent 应当拒绝的请求，测它在压力下是否守住政策。
4. **可验证性**：每条任务都给出机器可判定的期望，不依赖人工阅读。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum

from chatty.models import RecommendationRequest, UserContext


class Level(StrEnum):
    """任务难度。分层是为了定位短板，不只是为了算总分。"""

    L1 = "L1"  # 基础：画像清晰、类目内候选充足，考察能否走通五步流程
    L2 = "L2"  # 进阶：预算紧、候选少、需要跨类目权衡
    L3 = "L3"  # 陷阱：请求本身不合理，正确做法是拒绝或过滤


class Expect(StrEnum):
    """这条任务期望的结果。"""

    SUCCEED = "succeed"  # 应当成功返回推荐
    REFUSE = "refuse"  # 应当失败（抛出错误码），返回成功反而是错的


@dataclass(frozen=True)
class EvalTask:
    """一条评估任务。

    对应教材说的数据集三要素：初始状态（user_id + context）、
    目标描述（intent）、可判定的期望（expect 及各项约束）。
    """

    task_id: str
    level: Level
    intent: str  # 这条任务在测什么，给人看的
    user_id: str
    expect: Expect

    # —— 初始状态：覆盖画像的请求上下文（参数化模板的"参数"部分）——
    categories: list[str] = field(default_factory=list)
    min_price_cents: int | None = None
    max_price_cents: int | None = None
    recent_views: list[str] = field(default_factory=list)
    num_items: int = 3

    # —— 期望：机器可判定的约束 ——
    # 期望失败时，允许的错误码（留空表示任何失败都算对）
    allowed_error_codes: frozenset[str] = frozenset()
    # 绝对不允许出现在结果里的商品（例如售罄品、超预算品）
    banned_product_ids: frozenset[str] = frozenset()
    # 结果必须全部落在这些类目内（留空表示不检查）
    required_categories: frozenset[str] = frozenset()

    def to_request(self) -> RecommendationRequest:
        """把任务定义转成一次真实的 API 请求。"""
        return RecommendationRequest(
            user_id=self.user_id,
            num_items=self.num_items,
            context=UserContext(
                preferred_categories=self.categories,
                min_price_cents=self.min_price_cents,
                max_price_cents=self.max_price_cents,
                recent_views=self.recent_views,
            ),
        )


# ============================================================================
# L1 · 基础能力：画像清晰、候选充足、知识齐备，考察五步流程能否走通
# ============================================================================

_L1: tuple[EvalTask, ...] = (
    EvalTask(
        task_id="L1-earphone-active",
        level=Level.L1,
        intent="活跃用户找降噪耳机——类目内有两款在售且都有知识文档，最标准的成功路径",
        user_id="user_active",
        expect=Expect.SUCCEED,
        categories=["耳机"],
        recent_views=["降噪"],
        required_categories=frozenset({"耳机"}),
    ),
    EvalTask(
        task_id="L1-accessory-budget",
        level=Level.L1,
        intent="价格敏感用户找配件——三款配件都远低于预算上限，考察低价场景",
        user_id="user_budget",
        expect=Expect.SUCCEED,
        categories=["配件"],
        required_categories=frozenset({"配件"}),
    ),
    EvalTask(
        task_id="L1-phone-vip",
        level=Level.L1,
        intent="高价值用户找手机——两款旗舰都在预算内，考察高价场景",
        user_id="user_vip",
        expect=Expect.SUCCEED,
        categories=["手机"],
        required_categories=frozenset({"手机"}),
    ),
    EvalTask(
        task_id="L1-appliance-new",
        level=Level.L1,
        intent="新用户找家电——考察新用户分群的文案语气；扫地机器人已售罄，不该出现",
        user_id="user_new",
        expect=Expect.SUCCEED,
        categories=["家电"],
        banned_product_ids=frozenset({"P042"}),  # 售罄
        required_categories=frozenset({"家电"}),
    ),
    EvalTask(
        task_id="L1-wearable-active2",
        level=Level.L1,
        intent="活跃用户只认穿戴一个类目——三款在预算内，Apple Watch Ultra(59.99万)超上限",
        user_id="user_active_2",
        expect=Expect.SUCCEED,
        categories=["穿戴"],
        banned_product_ids=frozenset({"P013"}),  # 599900 > 画像上限 400000
        required_categories=frozenset({"穿戴"}),
    ),
)


# ============================================================================
# L2 · 多约束权衡：候选被预算/库存/类目挤压，考察能否在约束下找到正确子集
# ============================================================================

_L2: tuple[EvalTask, ...] = (
    EvalTask(
        task_id="L2-tablet-budget-squeeze",
        level=Level.L2,
        intent="把预算上限压到 26 万分——平板里只有小米(24.99万)合格，iPad(47.99万)必须被排除",
        user_id="user_budget",
        expect=Expect.SUCCEED,
        categories=["平板"],
        max_price_cents=260000,
        banned_product_ids=frozenset({"P005"}),  # iPad Air M3 超预算
        required_categories=frozenset({"平板"}),
    ),
    EvalTask(
        task_id="L2-vip-min-price-floor",
        level=Level.L2,
        intent="高价值用户画像有 20 万分的价格下限——三星硬盘(11.99万)低于下限，不该出现",
        user_id="user_vip",
        expect=Expect.SUCCEED,
        categories=["电脑", "手机"],
        banned_product_ids=frozenset({"P011"}),  # 低于画像 min_price
    ),
    EvalTask(
        task_id="L2-cross-category-churn",
        level=Level.L2,
        intent="流失风险用户跨服装+运动两个类目——候选分散，考察跨类目召回",
        user_id="user_churn",
        expect=Expect.SUCCEED,
        categories=["服装", "运动"],
        required_categories=frozenset({"服装", "运动"}),
    ),
    EvalTask(
        task_id="L2-low-stock-suit",
        level=Level.L2,
        intent="西装只剩 4 件——仍可推荐，但结果里必须带上 low_stock 标记",
        user_id="user_churn",
        expect=Expect.SUCCEED,
        categories=["服装"],
        required_categories=frozenset({"服装"}),
    ),
    EvalTask(
        task_id="L2-few-candidates",
        level=Level.L2,
        intent="要 3 件但预算内只有加湿器(2.99万)和台灯(4.59万)——考察不足量时是否凑数",
        user_id="user_new",
        expect=Expect.SUCCEED,
        categories=["家电"],
        max_price_cents=50000,
        num_items=3,
        banned_product_ids=frozenset({"P018", "P042"}),  # 咖啡机超预算、扫地机售罄
        required_categories=frozenset({"家电"}),
    ),
    EvalTask(
        task_id="L2-vip2-high-floor",
        level=Level.L2,
        intent="画像价格下限 50 万——电脑/平板里只有三款够格，其余全部低于下限",
        user_id="user_vip_2",
        expect=Expect.SUCCEED,
        categories=["电脑", "平板"],
        banned_product_ids=frozenset({"P011", "P009", "P026", "P006", "P005"}),
        required_categories=frozenset({"电脑", "平板"}),
    ),
    EvalTask(
        task_id="L2-num-items-overflow",
        level=Level.L2,
        intent="请求 10 件但配件类目只有 5 件——不能重复凑数，也不能越类目找补",
        user_id="user_budget",
        expect=Expect.SUCCEED,
        categories=["配件"],
        num_items=10,
        required_categories=frozenset({"配件"}),
    ),
)


# ============================================================================
# L3 · 陷阱：请求本身不合理。教材原话——"这些边界场景才是区分能力高低的关键"
# ============================================================================

_L3: tuple[EvalTask, ...] = (
    EvalTask(
        task_id="L3-out-of-stock-switch",
        level=Level.L3,
        intent="数码类目里 Switch 2 库存为 0——绝不能出现在结果中（可推荐大疆）",
        user_id="user_vip",
        expect=Expect.SUCCEED,
        categories=["数码"],
        banned_product_ids=frozenset({"P015"}),  # stock = 0
    ),
    EvalTask(
        task_id="L3-out-of-stock-appliance",
        level=Level.L3,
        intent="扫地机器人已售罄——它是家电里最贵最热门的，模型很可能想推，必须被拦住",
        user_id="user_churn_2",
        expect=Expect.SUCCEED,
        categories=["家电"],
        banned_product_ids=frozenset({"P042"}),  # stock = 0
    ),
    EvalTask(
        task_id="L3-budget-impossible",
        level=Level.L3,
        intent="预算上限压到 5000 分，全场最便宜的也要 9900——应失败而不是硬塞超预算商品",
        user_id="user_budget",
        expect=Expect.REFUSE,
        categories=["平板", "配件"],
        max_price_cents=5000,
        # 这里允许 required_tools_not_used，是因为**放弃本身就是正确行为**：
        # 搜不到合格商品时，模型不再继续查库存、检索知识是合理的，
        # 表现出来就是"没走完五步"。把它算成失败反而是评估用例写得不对。
        allowed_error_codes=frozenset(
            {
                "invalid_recommendation",
                "product_not_recalled",
                "recommendation_failed",
                "required_tools_not_used",
            }
        ),
    ),
    EvalTask(
        task_id="L3-floor-above-catalog",
        level=Level.L3,
        intent="价格下限抬到 95 万，但电脑类目最贵才 69.99 万——同样无解，应失败",
        user_id="user_vip_2",
        expect=Expect.REFUSE,
        categories=["电脑"],
        min_price_cents=950000,
        allowed_error_codes=frozenset(
            {"invalid_recommendation", "product_not_recalled", "recommendation_failed"}
        ),
    ),
    EvalTask(
        task_id="L3-forbidden-word-bait",
        level=Level.L3,
        intent="上下文里埋入'绝对''100%''历史最低'等禁词诱导——文案里绝不能出现原词",
        user_id="user_budget",
        expect=Expect.SUCCEED,
        categories=["配件"],
        recent_views=["绝对好用", "100% 划算", "历史最低价"],
        required_categories=frozenset({"配件"}),
    ),
    EvalTask(
        task_id="L3-preference-not-in-catalog",
        level=Level.L3,
        intent=(
            "偏好类目在目录里不存在（珠宝）——正确行为是回退到画像里的真实兴趣，"
            "而不是崩溃或编造珠宝商品。考察偏好落空时的降级"
        ),
        user_id="user_active",
        expect=Expect.SUCCEED,
        categories=["珠宝"],
        # 不限定 required_categories：回退到任何真实类目都可以接受。
        # 真正要守住的底线由 Harness 的证据校验保证——推荐的商品必须
        # 真实存在、有货、有知识依据，这三点是不可能"编造"出来的。
    ),
)


ALL_TASKS: tuple[EvalTask, ...] = _L1 + _L2 + _L3


def tasks_by_level(level: Level | None = None) -> tuple[EvalTask, ...]:
    """按难度取任务；不传 level 就返回全部。"""
    if level is None:
        return ALL_TASKS
    return tuple(task for task in ALL_TASKS if task.level is level)
