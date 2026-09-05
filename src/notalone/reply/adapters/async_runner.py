"""为同步 ReplyRuntime 提供同一进程内的可取消异步模型运行。

复用一个事件循环，避免重复 asyncio.run 关闭模型 HTTP 客户端所属循环。
取消会阻止后续模型步骤；已在线程中执行的只读 Tool 仍由自身 I/O 时限收尾。
"""

import asyncio
from collections.abc import Coroutine
from threading import Lock, Thread
from typing import Any, TypeVar

_Result = TypeVar("_Result")
_loop: asyncio.AbstractEventLoop | None = None
_lock = Lock()


def _runtime_loop() -> asyncio.AbstractEventLoop:
    global _loop
    with _lock:
        if _loop is None:
            _loop = asyncio.new_event_loop()
            Thread(
                target=_loop.run_forever,
                name="notalone-reply-runtime",
                daemon=True,
            ).start()
        return _loop


def run_with_timeout(
    operation: Coroutine[Any, Any, _Result], *, seconds: float,
) -> _Result:
    """等待本次运行取消完成；异常路径也不会把迟到结果交给 Store。"""

    async def bounded() -> _Result:
        async with asyncio.timeout(seconds):
            return await operation

    future = asyncio.run_coroutine_threadsafe(bounded(), _runtime_loop())
    try:
        # 异步取消通常立即完成；外层余量防止异常 adapter 吞掉取消后拖住 HTTP。
        return future.result(timeout=seconds + 2)
    except TimeoutError:
        future.cancel()
        raise
