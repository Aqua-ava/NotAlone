#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .build
available=$(df -k . | awk 'NR==2 {print $4}')
temporary=$(df -k /tmp | awk 'NR==2 {print $4}')
if (( available < 15*1024*1024 || temporary < 15*1024*1024 )); then
  echo '媒体探针构建空间不足15GiB' >&2
  exit 1
fi
binary=$(mktemp .build/media-validation.XXXXXX)
trap 'rm -f "$binary"' EXIT
xcrun swiftc -parse-as-library -target arm64-apple-macosx15.0 -O main.swift shared.swift image-container.swift hevc.swift wxgf.swift -o "$binary"
chmod 700 "$binary"
mv -f "$binary" .build/media-validation
