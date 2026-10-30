#!/bin/bash
# 仅用于合成验收；不会由产品运行时调用。
set -euo pipefail
cd "$(dirname "$0")"
if [[ $# != 1 || "$1" != /* || ! -d "$1" ]]; then
  echo '请提供已创建的合成夹具目录' >&2
  exit 1
fi
mkdir -p .build
available=$(df -k . | awk 'NR==2 {print $4}')
temporary=$(df -k /tmp | awk 'NR==2 {print $4}')
if (( available < 15*1024*1024 || temporary < 15*1024*1024 )); then
  echo '媒体夹具构建空间不足15GiB' >&2
  exit 1
fi
if [[ ! -x .build/fixtures || fixtures.swift -nt .build/fixtures ]]; then
  binary=$(mktemp .build/fixtures.XXXXXX)
  trap 'rm -f "$binary"' EXIT
  xcrun swiftc -parse-as-library -target arm64-apple-macosx15.0 fixtures.swift -o "$binary"
  chmod 700 "$binary"
  mv -f "$binary" .build/fixtures
fi
.build/fixtures "$1"
