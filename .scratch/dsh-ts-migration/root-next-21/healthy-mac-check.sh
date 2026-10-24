#!/bin/sh
set -eu

script_dir=$(cd "$(dirname "$0")" && pwd -P)
python=${PYTHON3:-/usr/bin/python3}
expected_pixel=2de93b11fa1b3cebd299528b3f057f8bf3d5aa9c5a64d50675ea31aa355009a9

if [ "${NOTALONE_ALLOW_ANE_PROBE:-0}" != "1" ]; then
  printf '%s\n' "默认不运行 OCR。确认这是健康 Mac 对照后设置 NOTALONE_ALLOW_ANE_PROBE=1。" >&2
  exit 2
fi
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  printf '%s\n' "该对照只适用于 arm64 macOS。" >&2
  exit 2
fi

os_version=$(sw_vers -productVersion)
case "$os_version" in
  27.*) ;;
  *)
    printf '需要 macOS 27 对照，当前为 %s。\n' "$os_version" >&2
    exit 2
    ;;
esac

test -x "$python"
diagnostic_dir=$(mktemp -d /private/tmp/notalone-21-healthy-mac.XXXXXX)
case "$diagnostic_dir" in
  /private/tmp/notalone-21-healthy-mac.*) ;;
  *) exit 2 ;;
esac
trap 'rm -rf "$diagnostic_dir"' EXIT HUP INT TERM

printf '{"event":"environment","os":"%s","build":"%s","arch":"%s","timeout_ms":2500,"ocr_runs":1}\n' \
  "$os_version" "$(sw_vers -buildVersion)" "$(uname -m)"

xcrun swiftc -O -parse-as-library \
  -framework AppKit -framework CoreGraphics -framework CoreText \
  -framework CoreVideo -framework Vision -framework CryptoKit \
  "$script_dir/language-path-probe.swift" \
  -o "$diagnostic_dir/language-path-probe"

set +e
result=$(
  "$python" "$script_dir/bounded-run.py" \
    --runner "$diagnostic_dir/language-path-probe" \
    --arg baseline \
    --timeout-ms 2500
)
probe_status=$?
set -e
printf '%s\n' "$result"

if [ "$probe_status" -ne 0 ]; then
  printf '%s\n' '{"event":"check_failed","reason":"probe exited nonzero"}' >&2
  exit 1
fi
pixel=$(
  printf '%s\n' "$result" |
    "$python" -c 'import json,sys; events=json.load(sys.stdin).get("events", []); print(next((e.get("pixel_sha256", "") for e in events if e.get("event") == "frame_ready"), ""))'
)
if [ "$pixel" != "$expected_pixel" ]; then
  printf '{"event":"check_failed","reason":"fixed input digest mismatch"}\n' >&2
  exit 1
fi
printf '%s\n' '{"event":"check_passed","conditions":["accurate","revision3","zh-Hans+en-US","2500ms","confidence>=0.90","exact synthetic text"]}'
