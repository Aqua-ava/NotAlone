#!/bin/sh
# 仅用于合成验收runtime；正式prepare-runtime不复制此入口。
manual_bin=$(/usr/bin/dirname "$0")
exec /usr/bin/sandbox-exec -f "$manual_bin/manual-loopback.sb" "$manual_bin/python3.12-real" "$@"
