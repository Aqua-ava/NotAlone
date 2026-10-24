"""仅HEAD与完整记忆管理闭包构造隔离树，排除其他票未提交装配。"""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import tarfile
import tempfile


ROOT = Path(__file__).resolve().parents[3]
SOURCES = [
    "memory-candidate-projection.ts", "memory-errors.ts", "memory-manual.ts",
    "memory-mutations-candidate-versions.ts", "memory-mutations-candidate.ts",
    "memory-mutations-erasure.ts", "memory-mutations-protection.ts",
    "memory-mutations.ts", "memory-owner-projection.ts", "memory-read.ts",
    "memory-service.ts", "preference-erasure.ts", "preference-files.ts",
    "contact-overview-time.ts", "contact-overview-versions.ts",
]
TESTS = [
    "memory-candidate-projection.test.mjs", "memory-management.test.mjs",
    "memory-mutations.test.mjs", "memory-mutations-candidate.test.mjs",
    "preference-files.test.mjs",
]
FILES = [f"backend-ts/src/{name}" for name in SOURCES]
FILES += [f"backend-ts/test/{name}" for name in TESTS]
NODE = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"


def main():
    base = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    hashes = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in FILES}
    with tempfile.TemporaryDirectory(prefix="notalone-memory-component-") as directory:
        temporary = Path(directory)
        archive = temporary / "base.tar"
        subprocess.run(["git", "archive", "--output", str(archive), base, "backend", "backend-ts"], cwd=ROOT, check=True)
        with tarfile.open(archive) as source:
            source.extractall(temporary, filter="data")
        archive.unlink()
        for name in FILES:
            shutil.copyfile(ROOT / name, temporary / name)
        (temporary / "backend-ts/node_modules").symlink_to(ROOT / "backend-ts/node_modules", target_is_directory=True)
        environment = {**os.environ, "NOTALONE_DISABLE_DOTENV": "1"}
        subprocess.run([str(NODE), "--test", *[f"test/{name}" for name in TESTS]], cwd=temporary / "backend-ts", env=environment, check=True, timeout=180)
        subprocess.run([str(NODE), "node_modules/typescript/bin/tsc", "--noEmit"], cwd=temporary / "backend-ts", env=environment, check=True, timeout=60)
    if any(hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != digest for name, digest in hashes.items()):
        raise RuntimeError("验证期间文件发生变化，结果不得用于归档")
    print(json.dumps({"base": base, "files": hashes, "tests": len(TESTS), "typecheck": "passed"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
