"""本场独立的显式审核信封；无默认判断、准则答复或模型审核。"""

from __future__ import annotations

import ctypes
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import stat
import time
from uuid import uuid4


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def private_directory(path):
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o700):
        raise ValueError("private_directory_required")
    return info.st_dev, info.st_ino


def publish(path, payload):
    """完整临时文件通过macOS独占rename发布；已有记录绝不覆盖。"""
    identity = private_directory(path.parent)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary = f".{path.name}-{uuid4().hex}.tmp"
    try:
        info = os.fstat(descriptor)
        if (info.st_dev, info.st_ino) != identity:
            raise ValueError("private_directory_changed")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=descriptor)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, sort_keys=True, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        if private_directory(path.parent) != identity:
            raise ValueError("private_directory_changed")
        libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        rename = libc.renameatx_np
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        if rename(descriptor, os.fsencode(temporary), descriptor, os.fsencode(path.name), 4):
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))
        os.fsync(descriptor)
        if private_directory(path.parent) != identity:
            raise ValueError("private_directory_changed")
    finally:
        try:
            os.unlink(temporary, dir_fd=descriptor)
        except FileNotFoundError:
            pass
        os.close(descriptor)


def read_private(path):
    def unique(pairs):
        result = {}
        for name, value in pairs:
            if name in result:
                raise ValueError("duplicate_json_key")
            result[name] = value
        return result

    identity = private_directory(path.parent)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "r", encoding="utf-8") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 8 * 1024 * 1024):
            raise ValueError("private_regular_file_required")
        value = json.load(stream, object_pairs_hook=unique,
            parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite_json")))
    if private_directory(path.parent) != identity or type(value) is not dict:
        raise ValueError("private_record_changed")
    return value


class ExplicitReviewBridge:
    def __init__(self, *, directory, run_id, deadline, clock=None, monotonic=time.monotonic, sleeper=time.sleep):
        self.directory, self.run_id, self.deadline = directory, str(run_id), deadline
        self.identity = private_directory(directory)
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.monotonic, self.sleeper = monotonic, sleeper
        self.seen = set()

    def review(self, phase, view):
        case = view.get("case_id") if phase == "raw" else view.get("packet", {}).get("case_id")
        if (phase not in {"raw", "full"} or type(case) is not str or not case.isalnum()
                or (case, phase) in self.seen or private_directory(self.directory) != self.identity):
            raise ValueError("explicit_review_phase_invalid")
        self.seen.add((case, phase))
        began = self.monotonic()
        binding = {"run_id": self.run_id, "phase": phase, "case_id": case,
                   "nonce": str(uuid4()), "view_sha256": digest(view)}
        stem = self.directory / f"{case}-{phase}"
        answer_path = stem.with_name(stem.name + "-review.json")
        if os.path.lexists(answer_path):
            raise ValueError("explicit_review_preexists")
        publish(stem.with_name(stem.name + "-view.json"), {
            **binding, "view": view, "deadline": self.deadline.isoformat(), "phase_seconds": 600,
        })
        received = False
        try:
            while True:
                if self.clock() >= self.deadline or self.monotonic() - began >= 600:
                    raise ValueError("explicit_review_timeout")
                if private_directory(self.directory) != self.identity:
                    raise ValueError("explicit_review_directory_changed")
                try:
                    answer = read_private(answer_path)
                except FileNotFoundError:
                    self.sleeper(0.2)
                    continue
                if (set(answer) != {*binding, "review"}
                        or any(answer.get(key) != value for key, value in binding.items())
                        or type(answer["review"]) is not dict
                        or self.clock() >= self.deadline or self.monotonic() - began >= 600):
                    raise ValueError("explicit_review_binding_invalid")
                received = True
                return answer["review"]
        finally:
            publish(stem.with_name(stem.name + "-receipt.json"), {
                **binding, "received": received, "elapsed_seconds": self.monotonic() - began,
                "finished_utc": self.clock().isoformat(),
            })
