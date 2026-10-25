"""只运行本次合成迁移回归，保存私有原始日志和脱敏证据。"""

from pathlib import Path
import argparse
import hashlib
import json
import os
import subprocess
import tempfile
import time


ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = Path(__file__).resolve().parent
PRIVATE = Path.home() / ".local/state/notalone/diagnostics/migration-resume-20261025/final-schema116-regression"
RUNTIME = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
CONDA = Path.home() / "miniconda3/envs/NotAlone/bin"
FILES = [
    "auto-read-suppression-migration",
    "cutover-rollback",
    "host-http",
    "model-call-learning-claim-migration",
    "model-call-receipt-migration",
]
CASES = {
    "auto-read": (FILES[0], "108升级"),
    "cutover": (FILES[1], "随机113旧库"),
    "host-http": (FILES[2], "未知数据库版本"),
    "learning-claim": (FILES[3], "110升级"),
    "receipt": (FILES[4], "109升级"),
}


def redact(value):
    value = value.replace(str(ROOT), "<REPO>")
    for directory in {tempfile.gettempdir(), str(Path(tempfile.gettempdir()).resolve())}:
        if directory != "/tmp":
            value = value.replace(directory, "<TEMP_ROOT>")
    return value.replace(str(Path.home()), "<PRIVATE_HOME>")


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("phase", choices=["red", "green", "related"])
parser.add_argument("case", nargs="?", choices=CASES)
args = parser.parse_args()
if args.phase != "related" and not args.case:
    parser.error("red/green 需要单例名称")

environment = {key: os.environ[key] for key in [
    "HOME", "USER", "LOGNAME", "TMPDIR", "SHELL", "LANG", "LC_ALL", "TZ",
] if key in os.environ}
environment.update(
    PATH=f"{RUNTIME}:{CONDA}:/usr/bin:/bin:/usr/sbin:/sbin",
    NOTALONE_TEST_PYTHON=str(CONDA / "python"),
    PYTHONNOUSERSITE="1",
)
command = [str(RUNTIME / "node"), "--test", "--test-concurrency=1"]
if args.phase == "related":
    command.extend(f"test/{name}.test.mjs" for name in FILES)
    command.append("test/extraction-policy-version-migration.test.mjs")
else:
    name, pattern = CASES[args.case]
    command.extend([f"--test-name-pattern={pattern}", f"test/{name}.test.mjs"])

label = args.phase if args.phase == "related" else f"{args.case}-{args.phase}"
PRIVATE.mkdir(mode=0o700, parents=True, exist_ok=True)
PRIVATE.chmod(0o700)
started = time.monotonic()
completed = subprocess.run(command, cwd=ROOT / "backend-ts", env=environment,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=240)
elapsed = round(time.monotonic() - started, 3)
raw = PRIVATE / f"{label}.raw.log"
raw.write_bytes(completed.stdout)
raw.chmod(0o600)
public_bytes = redact(completed.stdout.decode()).encode()
public = EVIDENCE / f"{label}.public.log"
public.write_bytes(public_bytes)
record = {
    "label": label,
    "command": redact(" ".join(command)),
    "working_directory": "backend-ts",
    "node_version": subprocess.check_output([str(RUNTIME / "node"), "--version"], text=True).strip(),
    "exit_code": completed.returncode,
    "elapsed_seconds": elapsed,
    "raw_sha256": hashlib.sha256(completed.stdout).hexdigest(),
    "public_sha256": hashlib.sha256(public_bytes).hexdigest(),
    "public_log": public.name,
    "environment": "只继承系统基础变量，不继承凭据或业务环境变量；仅使用夹具自建临时配置，Python迁移显式禁用dotenv",
}
(EVIDENCE / f"{label}.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(record, ensure_ascii=False))
print("\n".join(public_bytes.decode().splitlines()[-60:]))
raise SystemExit(completed.returncode)
