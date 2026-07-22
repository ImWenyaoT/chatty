"""NativeRuntime：单 SQLite 文件上的全部 store 聚合（specs/stores.md §0.1）。

连接拓扑：commerce/memory/support/traces/artifacts 各自建长连接；knowledge 复用
commerce.database（构造函数收连接对象）；SQLiteSession（会话历史）由 run 模块按
database_path 构造。写事务串行化由各 store 内部的进程级文件锁保证。
"""

from __future__ import annotations

from pathlib import Path

from chatty.artifacts import ArtifactStore
from chatty.commerce import CommerceStore
from chatty.knowledge import KnowledgeStore
from chatty.memory import MemoryStore
from chatty.support import SupportRequestStore
from chatty.traces import TraceStore


class NativeRuntime:
    """一个数据库文件上的 store 聚合根；HTTP 层与 run 模块共享同一实例。"""

    def __init__(self, database_path: str | Path) -> None:
        self.database_path = Path(database_path)
        self.commerce = CommerceStore(self.database_path)
        self.knowledge = KnowledgeStore(self.commerce.database)
        self.memory = MemoryStore(self.database_path)
        self.support = SupportRequestStore(self.database_path)
        self.traces = TraceStore(self.database_path)
        self.artifacts = ArtifactStore(self.database_path)

    def close(self) -> None:
        """关闭顺序（§0.1）：traces → support → memory → artifacts → commerce。

        knowledge 无 close：复用 commerce 连接。
        """
        self.traces.close()
        self.support.close()
        self.memory.close()
        self.artifacts.close()
        self.commerce.close()
