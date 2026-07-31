"""失败轨迹：跑的时候挂了，把复现需要的东西记下来。

这个 module 拥有三件事——日志的**位置**、**格式**和**脱敏规则**。写它的是 demo
（生产路径），读它的是 `python -m evals --harvest`（评估路径）；两端隔着一个文件，
所以这三件事必须只有一份定义，否则一端改了另一端读不出来。

它此前住在 evals/harvest.py 里，带来两个问题：

  · 路径是相对的（`.local/failures.jsonl`）。从别的 cwd 跑 demo 就写到别处去了，
    而 harvest 从仓库根读——「失败 → 回归用例」这个闭环会静默断掉，
    看上去只是「一直没有失败记录」。
  · demo.py 得 `from evals.harvest import ...`，生产代码依赖评估包。而 evals/
    不在 wheel 里（pyproject 只打包 src/chatty），装成包之后这行 import 直接失效。

脱敏在写入时做，不是在读的时候做——敏感字段就不该落到磁盘上，事后再清等于
已经泄露过一次。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from chatty import config
from chatty.models import RecommendationRequest

# 这些字段不落盘。chatty 的请求里本来没有隐私数据，
# 但把这条规矩立在这里，加字段的人才会想到这件事。
REDACTED_FIELDS = frozenset({"api_key", "token", "phone", "email", "address"})


@dataclass(frozen=True)
class FailureEntry:
    """一条失败记录。"""

    request: dict[str, object] = field(default_factory=dict)
    error_code: str = "unknown"
    diagnostics: dict[str, object] = field(default_factory=dict)


def record(
    request: RecommendationRequest,
    error_code: str,
    diagnostics: dict[str, object] | None = None,
    *,
    path: Path | None = None,
) -> None:
    """记一次失败，供之后收成回归用例。

    只记复现需要的东西：请求参数、错误码、诊断。不记模型的原始输出——
    那个既大又不稳定，而且回归用例要复现的是「这个输入会不会再挂」，
    不是「模型当时说了什么」。
    """
    path = path or config.FAILURE_LOG_PATH
    payload = request.model_dump(mode="json")
    entry = {
        "request": {k: v for k, v in payload.items() if k not in REDACTED_FIELDS},
        "error_code": error_code,
        "diagnostics": diagnostics or {},
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")


def read(path: Path | None = None) -> list[FailureEntry]:
    """读回全部失败记录。日志不存在就返回空列表，坏行跳过。

    坏行是常态而不是异常：进程在写到一半时被 Ctrl-C 掉，末尾就会留半行。
    为了一条残留放弃整份日志不划算。
    """
    path = path or config.FAILURE_LOG_PATH
    if not path.exists():
        return []

    entries: list[FailureEntry] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            raw = json.loads(line)
        except json.JSONDecodeError:
            continue  # 半行残留，跳过
        if not isinstance(raw, dict):
            continue
        request = raw.get("request")
        diagnostics = raw.get("diagnostics")
        entries.append(
            FailureEntry(
                request=request if isinstance(request, dict) else {},
                error_code=str(raw.get("error_code", "unknown")),
                diagnostics=diagnostics if isinstance(diagnostics, dict) else {},
            )
        )
    return entries
