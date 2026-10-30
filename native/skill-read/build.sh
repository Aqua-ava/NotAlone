#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .build
available=$(df -k . | awk 'NR==2 {print $4}')
temporary=$(df -k /tmp | awk 'NR==2 {print $4}')
if (( available < 15*1024*1024 || temporary < 15*1024*1024 )); then
  echo 'Skill 只读器构建空间不足15GiB' >&2
  exit 1
fi
if [[ -x .build/skill-read && .build/skill-read -nt main.c ]]; then exit 0; fi
binary=$(mktemp .build/skill-read.XXXXXX)
trap 'rm -f "$binary"' EXIT
xcrun clang -target arm64-apple-macosx15.0 -Wall -Wextra -Werror -O2 main.c -o "$binary"
chmod 700 "$binary"
mv -f "$binary" .build/skill-read
