"""测试共用的 fixture。

只有一个：`catalog`。它存在的理由是 `Recommender` **不拥有** 注入进去的 Catalog——
`close()` 只释放它自己建的模型客户端，数据库连接由建它的人关。
测试里到处写 `Recommender(Catalog())` 的话，谁也拿不到那个 Catalog 的引用去关。

顺带把测试从 `.local/chatty.db` 挪到 tmp_path：以前每个测试都往同一个真实库上
重新 seed 一遍，互相看得见对方的副作用。
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from chatty.catalog import Catalog


@pytest.fixture
def catalog(tmp_path: Path) -> Iterator[Catalog]:
    """一个测试一个独立的库。

    作用域刻意选 function 而不是 session：session 级的共享 Catalog 恰好重现了
    这次要消除的失效模式——一个测试关掉它，后面全崩。130ms 的 seed 成本买这个
    隔离很划算。
    """
    catalog = Catalog(database_path=tmp_path / "chatty.db")
    yield catalog
    catalog.close()
