#!/bin/zsh
set -eu

script_dir="${0:A:h}"
probe_dir="${script_dir:h}"
build_dir="${probe_dir}/build/cli"
module_cache_dir="${NOTALONE_PROBE_MODULE_CACHE_DIR:-/private/tmp/notalone-clang-module-cache}"

mkdir -p "${build_dir}"
mkdir -p "${module_cache_dir}"

env CLANG_MODULE_CACHE_PATH="${module_cache_dir}" \
    swiftc -O -parse-as-library \
    -emit-library \
    -emit-module \
    -module-name NotAloneSyncCore \
    -emit-module-path "${build_dir}/NotAloneSyncCore.swiftmodule" \
    "${probe_dir}/Sources/NotAloneSyncCore/ProbeCore.swift" \
    "${probe_dir}/Sources/NotAloneSyncCore/SessionCaptureSafety.swift" \
    "${probe_dir}/Sources/NotAloneSyncCore/RegionCalibration.swift" \
    "${probe_dir}/Sources/NotAloneSyncCore/MinimalRegionLayout.swift" \
    "${probe_dir}/Sources/NotAloneSyncCore/MinimalSessionCapture.swift" \
    "${probe_dir}/Sources/NotAloneSyncCore/AutomaticSessionCapture.swift" \
    "${probe_dir}/Sources/NotAloneSyncCore/SessionObservationWorker.swift" \
    "${probe_dir}/Sources/NotAloneSyncCore/HeaderTextFallback.swift" \
    "${probe_dir}/Sources/NotAloneSyncCore/HeaderChangeDetector.swift" \
    "${probe_dir}/Sources/NotAloneSyncCore/HeaderChangeGeometry.swift" \
    "${probe_dir}/Sources/NotAloneSyncCore/HeaderChangeDiagnostics.swift" \
    "${probe_dir}/Sources/NotAloneSyncCore/HeaderChangeSource.swift" \
    "${probe_dir}/Sources/NotAloneSyncCore/SessionCapturePreview.swift" \
    "${probe_dir}/Sources/NotAloneSyncCore/ForegroundStatusPreview.swift" \
    "${probe_dir}/Sources/NotAloneSyncCore/CaptureSupport.swift" \
    "${probe_dir}/Sources/NotAloneSyncCore/SelectedSession.swift" \
    "${probe_dir}/Sources/NotAloneSyncCore/FrontSyncStatusReport.swift" \
    "${probe_dir}/Sources/NotAloneSyncCore/BackendStatusPolling.swift" \
    -framework AppKit \
    -framework ScreenCaptureKit \
    -framework Vision \
    -framework CryptoKit \
    -Xlinker -install_name \
    -Xlinker "@rpath/libNotAloneSyncCore.dylib" \
    -o "${build_dir}/libNotAloneSyncCore.dylib"

env CLANG_MODULE_CACHE_PATH="${module_cache_dir}" \
    swiftc -O -parse-as-library \
    "${probe_dir}/Sources/NotAloneSyncCLI/main.swift" \
    -I "${build_dir}" \
    -L "${build_dir}" \
    -lNotAloneSyncCore \
    -framework AppKit \
    -framework CoreGraphics \
    -Xlinker -rpath \
    -Xlinker "@executable_path" \
    -o "${build_dir}/notalone-sync-probe"

# 代码相同但进程签名身份独立，避免正式短截图结束时打断持续顶部流。
cp "${build_dir}/notalone-sync-probe" "${build_dir}/notalone-header-change-source"

# 签名身份只接受显式配置；缺省使用ad-hoc，不查询或选择钥匙串中的证书。
signing_identity="${NOTALONE_PROBE_SIGNING_IDENTITY:--}"
codesign --force --sign "${signing_identity}" \
    --identifier "com.notalone.sync-probe.core" \
    "${build_dir}/libNotAloneSyncCore.dylib"
codesign --force --sign "${signing_identity}" \
    --identifier "com.notalone.sync-probe.cli" \
    "${build_dir}/notalone-sync-probe"
codesign --force --sign "${signing_identity}" \
    --identifier "com.notalone.sync-probe.header-change" \
    "${build_dir}/notalone-header-change-source"
if [[ "${signing_identity}" == "-" ]]; then
    echo "签名方式：ad-hoc；不代表屏幕录制权限身份稳定或已验证。"
else
    echo "签名方式：显式指定身份；实际权限归属仍须单独验证。"
fi

echo "已构建：${build_dir}/notalone-sync-probe"
echo "已构建：${build_dir}/notalone-header-change-source"
