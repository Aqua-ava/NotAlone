"""只在HEAD与三个边界修复文件组成的隔离树验证，不读取真实配置或微信。"""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import tarfile
import tempfile


ROOT = Path(__file__).resolve().parents[3]
FILES = [
    "backend-ts/src/sync-incremental-engine.ts",
    "backend-ts/src/sync-incremental-store.ts",
    "backend-ts/test/sync-incremental-new-only-boundary.test.mjs",
]
TESTS = [
    "test/sync-incremental-new-only-boundary.test.mjs",
    "test/sync-incremental-engine.test.mjs",
    "test/sync-incremental-store.test.mjs",
]
NODE = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"


def main():
    base = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    snapshots = {name: (ROOT / name).read_bytes() for name in FILES}
    hashes = {name: hashlib.sha256(data).hexdigest() for name, data in snapshots.items()}
    with tempfile.TemporaryDirectory(prefix="notalone-new-only-boundary-") as directory:
        temporary = Path(directory)
        archive = temporary / "base.tar"
        subprocess.run(["git", "archive", "--output", str(archive), base, "backend", "backend-ts"], cwd=ROOT, check=True)
        with tarfile.open(archive) as source:
            source.extractall(temporary, filter="data")
        archive.unlink()
        for name, data in snapshots.items():
            (temporary / name).write_bytes(data)
        (temporary / "backend-ts/node_modules").symlink_to(ROOT / "backend-ts/node_modules", target_is_directory=True)
        environment = {**os.environ, "NOTALONE_DISABLE_DOTENV": "1"}
        subprocess.run([str(NODE), "--test", "--test-concurrency=1", *TESTS], cwd=temporary / "backend-ts", env=environment, check=True, timeout=120)
        subprocess.run([str(NODE), "node_modules/typescript/bin/tsc", "--noEmit"], cwd=temporary / "backend-ts", env=environment, check=True, timeout=60)
    if any(hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != digest for name, digest in hashes.items()):
        raise RuntimeError("验证期间源文件发生变化，结果不得用于归档")
    print(json.dumps({"base": base, "files": hashes, "typecheck": "passed"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
