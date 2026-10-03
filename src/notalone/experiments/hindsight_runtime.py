"""独立本机 Hindsight 的安装、启动与停止；不读取业务配置。"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
from pathlib import Path


SOURCE_SHA = "f7dd3f4fd7420f7beec60c32c965e5e5cf7be066"
DEFAULT_RUNTIME = Path("/tmp/notalone-hindsight-runtime-f7dd3f4")
EMBED_MODEL = "BAAI/bge-small-zh-v1.5"
EMBED_SHA = "7999e1d3359715c523056ef9478215996d62a620"
RERANK_MODEL = "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1"
RERANK_SHA = "1427fd652930e4ba29e8149678df786c240d8825"
DB_NAME = "notalone-hindsight-f7dd3f4"
DB_URL = "postgresql://postgres:postgres@127.0.0.1:18543/postgres"


def clean_environment(runtime: Path, *, offline: bool = True) -> dict[str, str]:
    """只继承系统路径；全部文本推理使用固定本机离线模型。"""

    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "PYTHON_DOTENV_DISABLED": "1",
        "PYTHONUNBUFFERED": "1",
        "HF_HOME": str(runtime / "models"),
        "HF_HUB_DISABLE_XET": "1",
        "TOKENIZERS_PARALLELISM": "false",
        "OMP_NUM_THREADS": "2",
    }
    if offline:
        env["HF_HUB_OFFLINE"] = "1"
    return env


def model_path(runtime: Path, model: str, sha: str) -> Path:
    return (
        runtime
        / "models"
        / "hub"
        / ("models--" + model.replace("/", "--"))
        / "snapshots"
        / sha
    )


def run_external(runtime: Path, code: str, *, offline: bool = True) -> str:
    result = subprocess.run(
        [str(runtime / "venv/bin/python"), "-c", code],
        cwd=runtime,
        env=clean_environment(runtime, offline=offline),
        text=True,
        check=True,
        capture_output=True,
    )
    return result.stdout.strip()


def prepare(runtime: Path, source: Path) -> None:
    actual = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=source, text=True
    ).strip()
    if actual != SOURCE_SHA:
        raise ValueError("源码版本不是已核验的固定 SHA。")
    runtime.mkdir(parents=True, exist_ok=True)
    env = clean_environment(runtime, offline=False)
    env["UV_PROJECT_ENVIRONMENT"] = str(runtime / "venv")
    subprocess.run(
        [
            "uv",
            "sync",
            "--locked",
            "--package",
            "hindsight-api-slim",
            "--extra",
            "local-ml",
            "--extra",
            "embedded-db",
        ],
        cwd=source,
        env=env,
        check=True,
    )
    run_external(
        runtime,
        "from huggingface_hub import snapshot_download\n"
        + "\n".join(
            f"snapshot_download({model!r},revision={sha!r},ignore_patterns=['*.bin','*.h5','*.ot','onnx/*','openvino/*','flax_model.msgpack'])"
            for model, sha in ((EMBED_MODEL, EMBED_SHA), (RERANK_MODEL, RERANK_SHA))
        ),
        offline=False,
    )
    versions = run_external(
        runtime,
        "import importlib.metadata,json; print(json.dumps({k:importlib.metadata.version(k) for k in ['hindsight-api-slim','sentence-transformers','transformers','torch','pg0-embedded','toktok-rs']}))",
    )
    (runtime / "manifest.json").write_text(
        json.dumps(
            {
                "source_sha": SOURCE_SHA,
                "versions": json.loads(versions),
                "embedding": {"model": EMBED_MODEL, "sha": EMBED_SHA},
                "reranker": {"model": RERANK_MODEL, "sha": RERANK_SHA},
                "base_url": "http://127.0.0.1:18888",
                "database": "独立 pg0 PostgreSQL，127.0.0.1:18543/postgres",
                "inference": "CPU/local/offline",
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )


def database_code(runtime: Path, operation: str) -> str:
    init = f"from pg0 import Pg0; p=Pg0(name={DB_NAME!r},port=18543,data_dir={str(runtime / 'database')!r}); "
    actions = {
        "start": "print(p.info() if p.running else p.start())",
        "stop": "p.stop() if p.running else None",
        "status": "print(p.info() if p.running else 'stopped')",
    }
    return init + actions[operation]


def start(runtime: Path) -> None:
    pidfile = runtime / "service.pid"
    if pidfile.exists():
        try:
            os.kill(int(pidfile.read_text()), 0)
        except ProcessLookupError:
            pidfile.unlink()
        else:
            raise RuntimeError("实验 API 已运行。")
    print(run_external(runtime, database_code(runtime, "start")))
    env = clean_environment(runtime)
    env.update(
        {
            "HINDSIGHT_API_HOST": "127.0.0.1",
            "HINDSIGHT_API_PORT": "18888",
            "HINDSIGHT_API_DATABASE_URL": DB_URL,
            "HINDSIGHT_API_LLM_PROVIDER": "none",
            "HINDSIGHT_API_RETAIN_EXTRACTION_MODE": "chunks",
            "HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION": "false",
            "HINDSIGHT_API_EMBEDDINGS_PROVIDER": "local",
            "HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL": str(
                model_path(runtime, EMBED_MODEL, EMBED_SHA)
            ),
            "HINDSIGHT_API_RERANKER_PROVIDER": "local",
            "HINDSIGHT_API_RERANKER_LOCAL_MODEL": str(
                model_path(runtime, RERANK_MODEL, RERANK_SHA)
            ),
            "HINDSIGHT_API_EMBEDDINGS_LOCAL_FORCE_CPU": "true",
            "HINDSIGHT_API_RERANKER_LOCAL_FORCE_CPU": "true",
            "HINDSIGHT_API_OTEL_TRACES_ENABLED": "false",
            "HINDSIGHT_API_WORKERS": "1",
            "HINDSIGHT_API_WORKER_ENABLED": "false",
        }
    )
    (runtime / "service-config.json").write_text(
        json.dumps(
            {k: v for k, v in env.items() if k != "PATH"}, ensure_ascii=False, indent=2
        )
        + "\n"
    )
    with (runtime / "service.log").open("ab") as log:
        process = subprocess.Popen(
            [str(runtime / "venv/bin/hindsight-api")],
            cwd=runtime,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    pidfile.write_text(str(process.pid) + "\n")
    print(
        f"API 启动中：PID {process.pid}，http://127.0.0.1:18888；日志 {runtime / 'service.log'}"
    )


def stop(runtime: Path) -> None:
    pidfile = runtime / "service.pid"
    if pidfile.exists():
        try:
            os.kill(int(pidfile.read_text()), signal.SIGTERM)
        except ProcessLookupError:
            pass
        pidfile.unlink()
    print(run_external(runtime, database_code(runtime, "stop")))


def main() -> None:
    parser = argparse.ArgumentParser(description="仅管理新建的本机合成实验服务。")
    parser.add_argument("operation", choices=("prepare", "start", "stop", "status"))
    parser.add_argument("--runtime-dir", type=Path, default=DEFAULT_RUNTIME)
    parser.add_argument("--source", type=Path)
    args = parser.parse_args()
    if args.operation == "prepare":
        if args.source is None:
            parser.error("prepare 需要固定源码 --source")
        prepare(args.runtime_dir, args.source)
    elif args.operation == "start":
        start(args.runtime_dir)
    elif args.operation == "stop":
        stop(args.runtime_dir)
    else:
        print(run_external(args.runtime_dir, database_code(args.runtime_dir, "status")))


if __name__ == "__main__":
    main()
