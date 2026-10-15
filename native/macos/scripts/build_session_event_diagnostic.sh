#!/bin/zsh
set -eu

script_dir="${0:A:h}"
probe_dir="${script_dir:h}"
build_dir="${probe_dir}/build/diagnostics"
mkdir -p "${build_dir}"
swiftc -O -parse-as-library \
    "${probe_dir}/Diagnostics/SessionEventEvidence.swift" \
    "${probe_dir}/Diagnostics/SessionEventCapabilities.swift" \
    "${probe_dir}/Diagnostics/SessionEventPreview.swift" \
    -framework AppKit \
    -o "${build_dir}/session-event-capabilities"
codesign --force --sign - --identifier com.notalone.session-event-diagnostic \
    "${build_dir}/session-event-capabilities"
codesign --verify --strict "${build_dir}/session-event-capabilities"
echo "仅完成开发诊断构建与ad-hoc签名；未运行窗口、微信或通知监听。"
