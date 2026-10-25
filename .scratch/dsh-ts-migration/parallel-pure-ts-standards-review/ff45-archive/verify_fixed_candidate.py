"""只读核对固定候选与自有快照，不读取业务配置或业务资料。"""

import argparse
import hashlib
import json
import subprocess
from pathlib import Path

BASE = "e17d4c752c69618e90e43c42488f1cb2c4d1b7a4"
CANDIDATE = "ff45f2ec296c4cead326d2ab6f3cf7770c9396ab"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", type=Path, default=Path.cwd())
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    def git(*command):
        return subprocess.check_output(["git", "-C", str(args.repository), *command])

    assert git("rev-parse", CANDIDATE).decode().strip() == CANDIDATE
    assert git("merge-base", BASE, CANDIDATE).decode().strip() == BASE
    manifest = json.loads((args.snapshot / "source-manifest.json").read_text())
    assert manifest["ref"] == CANDIDATE
    for relative, expected in manifest["files"].items():
        assert digest((args.snapshot / relative).read_bytes()) == expected, relative
        assert digest(git("show", f"{CANDIDATE}:{relative}")) == expected, relative

    changed = git("diff", "--name-only", f"{BASE}...{CANDIDATE}").decode().splitlines()
    candidate_files = {relative: digest(git("show", f"{CANDIDATE}:{relative}")) for relative in changed}
    declared = json.loads(git("show", f"{CANDIDATE}:.scratch/dsh-ts-migration/pure-ts-unified-candidate/files.json"))
    for relative, metadata in declared["files"].items():
        assert digest(git("show", f"{CANDIDATE}:{relative}")) == metadata["sha256"], relative

    sql_files = [relative for relative in manifest["files"] if relative.startswith("backend/database/migrations/") and relative.endswith(".sql")]
    assert len(sql_files) == 115
    assert all(git("show", f"{BASE}:{relative}") == git("show", f"{CANDIDATE}:{relative}") for relative in sql_files)
    dependencies = {}
    for relative in [
        "backend-ts/node_modules/@deepseek-ai/dsh/package.json",
        "backend-ts/node_modules/@deepseek-ai/dsh-llm/package.json",
        "backend-ts/node_modules/@deepseek-ai/dsh-llm/lib/index.js",
        "backend-ts/node_modules/@deepseek-ai/dsh-llm-deepseek/package.json",
        "backend-ts/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js",
        "backend-ts/node_modules/pg/package.json",
        "backend-ts/node_modules/pg/lib/client.js",
        "desktop/node_modules/esbuild/package.json",
    ]:
        data = (args.snapshot / relative).read_bytes()
        dependencies[relative] = {"sha256": digest(data)}
        if relative.endswith("package.json"):
            dependencies[relative]["version"] = json.loads(data)["version"]

    result = {
        "base": BASE,
        "candidate": CANDIDATE,
        "merge_base_matches": True,
        "snapshot_verified_files": len(manifest["files"]),
        "declared_manifest_verified_files": len(declared["files"]),
        "changed_files": candidate_files,
        "original_sql_files_unchanged": len(sql_files),
        "dependency_files": dependencies,
        "snapshot_source_manifest_sha256": digest((args.snapshot / "source-manifest.json").read_bytes()),
        "working_tree_not_used_for_candidate_source": True,
    }
    args.output.write_text(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
    print(json.dumps({key: result[key] for key in ["candidate", "snapshot_verified_files", "declared_manifest_verified_files", "original_sql_files_unchanged"]}))


if __name__ == "__main__":
    main()
