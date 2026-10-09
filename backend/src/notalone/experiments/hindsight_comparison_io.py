"""正式实验的公开产物、版本和本机资源观测；不读取业务配置。"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
from pathlib import Path
import platform
import resource
import subprocess
from threading import Event, Thread
from typing import Any

from notalone.experiments.hindsight_dataset import (
    SyntheticDataset,
    canonical_json,
    dataset_documents,
)


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(canonical_json(value), encoding="utf-8")


def verify_frozen_dataset(dataset: SyntheticDataset, directory: Path) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for name, expected in dataset_documents(dataset).items():
        actual = (directory / name).read_bytes()
        if actual != expected.encode():
            raise ValueError("生成数据与冻结文件不一致，禁止运行最终实验。")
        hashes[name] = hashlib.sha256(actual).hexdigest()
    return hashes


def provenance(root: Path) -> dict[str, Any]:
    modules = sorted(
        {
            "src/notalone/scopes.py",
            *(
                str(path.relative_to(root))
                for package in ("memory", "retrieval", "reply", "experiments")
                for path in (root / "src/notalone" / package).glob("*.py")
            ),
        }
    )
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    diff = subprocess.run(
        ["git", "diff", "HEAD", "--", *modules],
        cwd=root,
        check=True,
        capture_output=True,
    ).stdout
    status = subprocess.run(
        ["git", "status", "--porcelain", "--", *modules],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    return {
        "code_commit_at_run": commit,
        "participating_tracked_diff_sha256": hashlib.sha256(diff).hexdigest(),
        "participating_status": status,
        "participating_file_sha256": {
            name: hashlib.sha256((root / name).read_bytes()).hexdigest()
            for name in modules
        },
        "new_modules_are_included_by_file_hash": True,
    }


def _command(command: list[str]) -> str:
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else "unavailable"


def hardware() -> dict[str, Any]:
    return {
        "platform": platform.platform(),
        "machine": platform.machine(),
        "product_python": platform.python_version(),
        "cpu": _command(["sysctl", "-n", "machdep.cpu.brand_string"]),
        "logical_cpus": _command(["sysctl", "-n", "hw.ncpu"]),
        "physical_memory_bytes": _command(["sysctl", "-n", "hw.memsize"]),
        "runtime_kind": "原生独立 Python 3.11 venv + pg0；不是容器",
    }


class ResourceObservation:
    """API 每秒抽样；不把 ps CPU/RSS 抽样最大值称完整进程峰值。"""

    def __init__(self, runtime: Path) -> None:
        self.runtime = runtime
        self.samples: list[dict[str, Any]] = []
        self._stop = Event()
        self._thread = Thread(target=self._sample, daemon=True)
        self._before = resource.getrusage(resource.RUSAGE_SELF)

    def start(self) -> None:
        self._thread.start()

    def _sample(self) -> None:
        while not self._stop.is_set():
            try:
                pid = int((self.runtime / "service.pid").read_text())
                output = _command(["ps", "-p", str(pid), "-o", "%cpu=", "-o", "rss="])
                cpu, rss = output.split()
                self.samples.append(
                    {
                        "at": datetime.now(timezone.utc).isoformat(),
                        "pid": pid,
                        "ps_cpu_percent": float(cpu),
                        "rss_kib": int(rss),
                    }
                )
            except (OSError, ValueError):
                self.samples.append(
                    {
                        "at": datetime.now(timezone.utc).isoformat(),
                        "error": "API采样不可用",
                    }
                )
            self._stop.wait(1.0)

    def finish(self) -> dict[str, Any]:
        self._stop.set()
        self._thread.join(timeout=3)
        measured = [item for item in self.samples if "rss_kib" in item]
        usage = resource.getrusage(resource.RUSAGE_SELF)
        return {
            "api_sampling_interval_seconds": 1.0,
            "api_max_sampled_rss_kib": max(
                (s["rss_kib"] for s in measured), default=None
            ),
            "api_max_sampled_ps_cpu_percent": max(
                (s["ps_cpu_percent"] for s in measured), default=None
            ),
            "samples": self.samples,
            "runner_user_cpu_seconds": usage.ru_utime - self._before.ru_utime,
            "runner_system_cpu_seconds": usage.ru_stime - self._before.ru_stime,
            "runner_process_peak_rss_bytes": (
                usage.ru_maxrss
                if platform.system() == "Darwin"
                else usage.ru_maxrss * 1024
            ),
            "storage_kib": {
                name: _command(["du", "-sk", str(self.runtime / name)]).split()[0]
                for name in ("database", "models", "venv")
            },
            "limits": "API是每秒ps抽样最大值，含整个dev校准和final；runner是OS记录峰值。数据库子进程和系统总内存未合计。",
        }
