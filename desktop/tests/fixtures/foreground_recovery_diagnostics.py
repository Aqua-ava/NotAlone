"""仅验收夹具记录前台观察的固定分类和耗时，不保留响应原文。"""

import json
import os
import time
from pathlib import Path


REASONS = frozenset({
    "confirmed_active_binding", "sync_disabled", "wechat_not_in_front",
    "probe_timeout", "observation_timeout", "foreground_observation_busy",
    "foreground_observation_unavailable", "runtime_stopped", "probe_failed",
    "calibration_windows_ambiguous", "automatic_capture_context_changed",
    "automatic_capture_window_metadata_changed", "automatic_capture_dimensions_changed",
    "automatic_layout_header_boundary", "automatic_layout_vertical_boundary",
    "group_chat_unsupported", "group_chat_suspected", "binding_verification_unavailable",
    "quality_unverified", "unmatched_requires_selection", "ambiguous_requires_selection",
})


def install():
    from notalone.server.app import BackendApp

    original = BackendApp.handle
    destination = Path(os.environ["NOTALONE_RECOVERY_DIAGNOSTICS"])

    def measured(self, **kwargs):
        if kwargs.get("method") != "POST" or kwargs.get("path") != "/api/sync/foreground/observe":
            return original(self, **kwargs)
        started = time.time() * 1000
        start = time.monotonic()
        response = original(self, **kwargs)
        payload = response.json()
        reason = payload.get("reason", payload.get("error")) if isinstance(payload, dict) else None
        phase = payload.get("phase") if isinstance(payload, dict) else None
        value = {"at": started, "elapsedMs": (time.monotonic() - start) * 1000,
                 "status": response.status_code,
                 "reason": reason if reason in REASONS else "unknown",
                 "phase": phase if phase in {"confirmed", "paused", "manual-required", "unavailable"} else None}
        with destination.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(value) + "\n")
        return response

    BackendApp.handle = measured
