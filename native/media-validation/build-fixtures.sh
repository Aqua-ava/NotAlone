#!/bin/bash
# 仅用于合成验收；不会由产品运行时调用。
set -euo pipefail
cd "$(dirname "$0")"
if [[ $# != 1 ]]; then
  echo '请提供已创建的合成夹具目录，或使用 --selftest' >&2
  exit 1
fi
if [[ "$1" != "--selftest" && ( "$1" != /* || ! -d "$1" ) ]]; then
  echo '合成夹具目录必须是已创建的绝对路径' >&2
  exit 1
fi
mkdir -p .build
available=$(df -k . | awk 'NR==2 {print $4}')
temporary=$(df -k /tmp | awk 'NR==2 {print $4}')
if (( available < 15*1024*1024 || temporary < 15*1024*1024 )); then
  echo '媒体夹具构建空间不足15GiB' >&2
  exit 1
fi
sources=(fixtures.swift shared.swift image-container.swift hevc.swift wxgf.swift)
rebuild=false
if [[ ! -x .build/fixtures ]]; then
  rebuild=true
else
  for source in "${sources[@]}"; do
    if [[ "$source" -nt .build/fixtures ]]; then rebuild=true; fi
  done
fi
if $rebuild; then
  binary=$(mktemp .build/fixtures.XXXXXX)
  trap 'rm -f "$binary"' EXIT
  xcrun swiftc -parse-as-library -target arm64-apple-macosx15.0 "${sources[@]}" -o "$binary"
  chmod 700 "$binary"
  mv -f "$binary" .build/fixtures
fi
.build/fixtures "$1"
