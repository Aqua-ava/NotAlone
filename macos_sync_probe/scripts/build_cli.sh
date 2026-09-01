#!/bin/zsh
set -eu

script_dir="${0:A:h}"
probe_dir="${script_dir:h}"
build_dir="${probe_dir}/build/cli"
module_cache_dir="/private/tmp/notalone-clang-module-cache"

mkdir -p "${build_dir}"
mkdir -p "${module_cache_dir}"

env CLANG_MODULE_CACHE_PATH="${module_cache_dir}" \
    swiftc -parse-as-library \
    -emit-library \
    -emit-module \
    -module-name NotAloneSyncCore \
    -emit-module-path "${build_dir}/NotAloneSyncCore.swiftmodule" \
    "${probe_dir}/Sources/NotAloneSyncCore/ProbeCore.swift" \
    "${probe_dir}/Sources/NotAloneSyncCore/CaptureSupport.swift" \
    "${probe_dir}/Sources/NotAloneSyncCore/SelectedSession.swift" \
    "${probe_dir}/Sources/NotAloneSyncCore/FrontSyncStatusReport.swift" \
    -framework AppKit \
    -framework ScreenCaptureKit \
    -framework Vision \
    -framework CryptoKit \
    -Xlinker -install_name \
    -Xlinker "@rpath/libNotAloneSyncCore.dylib" \
    -o "${build_dir}/libNotAloneSyncCore.dylib"

env CLANG_MODULE_CACHE_PATH="${module_cache_dir}" \
    swiftc -parse-as-library \
    "${probe_dir}/Sources/NotAloneSyncCLI/main.swift" \
    -I "${build_dir}" \
    -L "${build_dir}" \
    -lNotAloneSyncCore \
    -framework AppKit \
    -framework CoreGraphics \
    -Xlinker -rpath \
    -Xlinker "@executable_path" \
    -o "${build_dir}/notalone-sync-probe"

# ScreenCaptureKit 的授权按代码签名身份记忆；后台探针必须和主 App
# 使用同一台机器上的稳定证书签名，不能长期使用 swiftc 默认的 ad-hoc 签名。
signing_identity=$(security find-identity -p codesigning -v 2>/dev/null \
    | sed -n 's/^[[:space:]]*[0-9]*)[[:space:]]*[0-9A-F]* "\(.*\)".*/\1/p' \
    | head -1)
if [[ -n "${signing_identity}" ]]; then
    codesign --force --sign "${signing_identity}" \
        --identifier "com.notalone.sync-probe.core" \
        "${build_dir}/libNotAloneSyncCore.dylib"
    codesign --force --sign "${signing_identity}" \
        --identifier "com.notalone.sync-probe.cli" \
        "${build_dir}/notalone-sync-probe"
    echo "签名身份：${signing_identity}"
else
    codesign --force --sign - \
        --identifier "com.notalone.sync-probe.core" \
        "${build_dir}/libNotAloneSyncCore.dylib"
    codesign --force --sign - \
        --identifier "com.notalone.sync-probe.cli" \
        "${build_dir}/notalone-sync-probe"
    echo "签名身份：ad-hoc（每次重建后需重新授权屏幕录制）"
fi

echo "已构建：${build_dir}/notalone-sync-probe"
