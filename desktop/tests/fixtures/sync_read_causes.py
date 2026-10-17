"""验收专用旁路归因：不写联系人、定位符、游标、正文，不参与生产调度。"""

from contextvars import ContextVar
from functools import wraps
import time


class ReadCauseObserver:
    def __init__(self, locator, record):
        self.locator = locator
        self.record = record
        self.pending = {}
        self.phase = ContextVar("acceptance_enqueue_phase", default=None)
        self.reading = ContextVar("acceptance_read_sources", default=None)

    def queued(self, engine, locator, existed):
        if locator != self.locator or locator not in engine._pending_locator_set:
            return
        key = id(engine)
        # 已在队列但没有完整观察记录时，不能补推唯一来源。
        sources = self.pending.setdefault(key, {"unknown"}) if existed else set()
        phase = self.phase.get()
        sources.add(phase[1] if phase and phase[0] == key else "unknown")
        self.pending[key] = sources

    def tail_started(self, pid):
        if type(pid) is not int or pid <= 0:
            return
        sources = self.reading.get() or ("unknown",)
        attribution = ("unknown" if "unknown" in sources else
                       "single" if len(sources) == 1 else "mixed")
        try:
            self.record({"kind": "cli-read-cause", "pid": pid,
                         "started_at_ms": time.time() * 1000,
                         "sources": sorted(sources), "attribution": attribution,
                         # 产品按 cursor 有无分类；跨批初始快照也可能进入 live 分支。
                         "global_event_semantics": "product-classification-only"})
        except Exception:
            # 缺少测量只能判缺证，绝不改变受限读取的返回、异常或子进程。
            pass


def _observer(engine):
    try:
        return getattr(engine._cli, "read_cause_observer", None)
    except Exception:
        return None


def _reset(variable, token):
    if token is not None:
        try:
            variable.reset(token)
        except Exception:
            pass


def _install(engine_class):
    if getattr(engine_class, "_acceptance_read_causes_installed", False):
        return

    def phase_wrapper(name, source):
        original = getattr(engine_class, name)

        @wraps(original)
        def observed(engine, *args, **kwargs):
            observer = _observer(engine)
            if observer is None:
                return original(engine, *args, **kwargs)
            token = None
            try:
                token = observer.phase.set((id(engine), source(engine)))
            except Exception:
                pass
            try:
                return original(engine, *args, **kwargs)
            finally:
                _reset(observer.phase, token)

        setattr(engine_class, name, observed)

    phase_wrapper("_consume_global_events", lambda engine:
                  "global_live_event" if engine._global_cursor is not None
                  else "global_initial_batch")
    phase_wrapper("_enqueue_initial_or_safety_sweep", lambda engine:
                  "initial_reconciliation" if not engine._initial_scan_done
                  else "backfill_reconciliation" if engine._backfill_check_requested
                  else "safety_reconciliation")
    for name in ("_enqueue_priority_live_read", "_prioritize_pending"):
        phase_wrapper(name, lambda engine: "priority_reconciliation")

    original_enqueue = engine_class._enqueue

    @wraps(original_enqueue)
    def enqueue(engine, locator):
        existed = locator in engine._pending_locator_set
        result = original_enqueue(engine, locator)
        observer = _observer(engine)
        if observer is not None:
            try:
                observer.queued(engine, locator, existed)
            except Exception:
                observer.pending.pop(id(engine), None)
        return result

    original_read = engine_class._read_binding

    @wraps(original_read)
    def read(engine, binding, *args, **kwargs):
        observer = _observer(engine)
        if observer is None:
            return original_read(engine, binding, *args, **kwargs)
        token = None
        try:
            sources = (observer.pending.pop(id(engine), {"unknown"})
                       if binding.conversation_locator == observer.locator else None)
            token = observer.reading.set(tuple(sorted(sources)) if sources else None)
        except Exception:
            pass
        try:
            return original_read(engine, binding, *args, **kwargs)
        finally:
            _reset(observer.reading, token)

    original_close = engine_class.close

    @wraps(original_close)
    def close(engine):
        try:
            return original_close(engine)
        finally:
            observer = _observer(engine)
            if observer is not None:
                observer.pending.pop(id(engine), None)

    engine_class._enqueue = enqueue
    engine_class._read_binding = read
    engine_class.close = close
    engine_class._acceptance_read_causes_installed = True


def attach(cli, processes, record):
    """仅绑定已通过范围守卫的 CLI；实际进程审计成功后才输出正 PID。"""
    from notalone.front_sync.cli_sync import CliBackgroundSync

    _install(CliBackgroundSync)
    observer = ReadCauseObserver(cli.guard.scope.locator, record)
    cli.read_cause_observer = observer
    processes.tail_started = observer.tail_started
