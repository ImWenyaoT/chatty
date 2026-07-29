"""评估入口。

    uv run python -m evals              # 跑全部任务（需要配好模型密钥）
    uv run python -m evals --level L3   # 只跑陷阱任务
    uv run python -m evals --repeat 3   # 每条任务跑 3 次，得到 Pass^k
    uv run python -m evals --retrieval  # 只评检索质量，不调模型、零成本
    uv run python -m evals --ablation   # 消融实验：拿掉工具与 Harness 的对照组
    uv run python -m evals --json       # 输出机器可读的指标

注意评估跑的是**真实模型 + 完整 Harness**，
所以会产生 API 调用费用；先用 --level L1 跑几条确认链路通，再全量。
"""

from __future__ import annotations

import argparse
import asyncio

from chatty import config
from evals.ablation import render_ablation_report, result_to_json, run_ablation
from evals.dataset import Level, tasks_by_level
from evals.multiturn import multiturn_to_json, render_multiturn_report, run_multiturn_suite
from evals.report import render_text, summarize
from evals.retrieval import evaluate_retrieval, render_retrieval_report
from evals.runner import run_suite


def main() -> None:
    parser = argparse.ArgumentParser(description="Chatty 评估")
    parser.add_argument(
        "--level",
        choices=[level.value for level in Level],
        help="只跑某个难度的任务；不指定则跑全部",
    )
    parser.add_argument("--json", action="store_true", help="输出 JSON 而不是文本报告")
    parser.add_argument("--concurrency", type=int, default=2, help="并发度，默认 2 以避免限流")
    parser.add_argument(
        "--repeat",
        type=int,
        default=1,
        help="每条任务重复跑几次；>1 才能算出 Pass^k（稳定性）。注意耗时和费用成倍增加",
    )
    parser.add_argument(
        "--retrieval",
        action="store_true",
        help="只评估检索质量（recall@k / MRR）。不调模型，零成本、完全确定",
    )
    parser.add_argument(
        "--multiturn",
        action="store_true",
        help="多轮评估：用户模拟器按剧本渐进透露信息，测 Agent 会不会把缺的问出来",
    )
    parser.add_argument(
        "--ablation",
        action="store_true",
        help="消融实验：拿掉工具与 Harness，量化裸模型的输出坏成什么样（可配 --level 只跑一档）",
    )
    args = parser.parse_args()

    # 检索评估不需要模型，单独走一条路径，方便快速验证改动有没有影响召回
    if args.retrieval:
        print(render_retrieval_report(evaluate_retrieval()))
        return

    if args.multiturn:
        verdicts = asyncio.run(run_multiturn_suite())
        print(multiturn_to_json(verdicts) if args.json else render_multiturn_report(verdicts))
        return

    if args.ablation:
        # 消融也尊重 --level：只想快速看对比时跑 L1 就够（5 条约 1 分钟）
        picked = tasks_by_level(Level(args.level) if args.level else None)
        result = asyncio.run(run_ablation(picked))
        print(result_to_json(result) if args.json else render_ablation_report(result))
        return

    level = Level(args.level) if args.level else None
    tasks = tasks_by_level(level)

    run = asyncio.run(
        run_suite(
            tasks,
            model_id=config.configured_model_id(),
            concurrency=args.concurrency,
            repeat=args.repeat,
        )
    )

    if args.json:
        print(summarize(run).to_json())
    else:
        print(render_text(run))


if __name__ == "__main__":
    main()
