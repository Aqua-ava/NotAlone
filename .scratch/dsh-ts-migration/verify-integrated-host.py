"""在已提交源码与精确共享接线覆盖上验证官方profile，不混入其他在途模块。"""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile


ROOT = Path(__file__).resolve().parents[2]
FILES = [
    "backend-ts/src/host-plugin.ts",
    "backend/src/notalone/server/app.py",
    "backend/src/notalone/server/command.py",
    "backend/src/notalone/server/memory_management_handoff.py",
    "backend-ts/test/memory-preferences-host.test.mjs",
    "backend-ts/test/foreground-location-host.test.mjs",
    "backend-ts/test/sync-incremental-host.test.mjs",
    "backend-ts/test/foreground-location-fixture.mjs",
]
TESTS = [name.removeprefix("backend-ts/") for name in FILES if name.endswith(".test.mjs")]
NODE = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"


def main():
    base = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    hashes = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in FILES}
    with tempfile.TemporaryDirectory(prefix="notalone-integrated-host-") as directory:
        temporary = Path(directory)
        archive = temporary / "base.tar"
        subprocess.run(["git", "archive", "--output", str(archive), base, "backend", "backend-ts", "desktop"], cwd=ROOT, check=True)
        with tarfile.open(archive) as source:
            source.extractall(temporary, filter="data")
        archive.unlink()
        for name in FILES:
            shutil.copyfile(ROOT / name, temporary / name)
            if hashlib.sha256((temporary / name).read_bytes()).hexdigest() != hashes[name]:
                raise RuntimeError("共享覆盖文件复制不一致，停止验证")
        for name in ["backend-ts", "desktop"]:
            (temporary / name / "node_modules").symlink_to(ROOT / name / "node_modules", target_is_directory=True)
        environment = {**os.environ, "NOTALONE_DISABLE_DOTENV": "1", "NOTALONE_TEST_INCREMENTAL_OVERLAY": "0"}
        tests = TESTS
        arguments = [str(NODE), "--test", "--test-concurrency=1"]
        if "--smoke" in sys.argv:
            tests = ["test/memory-preferences-host.test.mjs"]
            arguments.append("--test-name-pattern=官方profile管理认证")
        elif "--foreground-revoke" in sys.argv:
            tests = ["test/foreground-location-host.test.mjs"]
            arguments.append("--test-name-pattern=授权撤销等待事务时客户端断连")
        print(json.dumps({"phase": "before_tests", "base": base, "files": hashes}, ensure_ascii=False), flush=True)
        subprocess.run([*arguments, *tests], cwd=temporary / "backend-ts", env=environment, check=True, timeout=240)
        subprocess.run([str(NODE), "node_modules/typescript/bin/tsc", "--noEmit"], cwd=temporary / "backend-ts", env=environment, check=True, timeout=60)
    if any(hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != digest for name, digest in hashes.items()):
        raise RuntimeError("验证期间共享覆盖文件发生变化，结果无效")
    mode = "smoke" if "--smoke" in sys.argv else "foreground-revoke" if "--foreground-revoke" in sys.argv else "integrated"
    print(json.dumps({"base": base, "files": hashes, "mode": mode, "typecheck": "passed"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
