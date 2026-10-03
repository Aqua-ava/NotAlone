#!/bin/zsh
set -eu

script_dir="${0:A:h}"
probe_dir="${script_dir:h}"
app_dir="${probe_dir}/build/NotAloneSyncProbe.app"
framework_dir="${app_dir}/Contents/Frameworks"
module_dir="${probe_dir}/build/modules"
module_cache_dir="/private/tmp/notalone-clang-module-cache"

mkdir -p "${app_dir}/Contents/MacOS"
mkdir -p "${framework_dir}"
mkdir -p "${module_dir}"
mkdir -p "${module_cache_dir}"

env CLANG_MODULE_CACHE_PATH="${module_cache_dir}" \
    swiftc -parse-as-library \
    -emit-library \
    -emit-module \
    -module-name NotAloneSyncCore \
    -emit-module-path "${module_dir}/NotAloneSyncCore.swiftmodule" \
    "${probe_dir}/Sources/NotAloneSyncCore/ProbeCore.swift" \
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
    -o "${framework_dir}/libNotAloneSyncCore.dylib"

env CLANG_MODULE_CACHE_PATH="${module_cache_dir}" \
    swiftc -parse-as-library \
    "${probe_dir}/Sources/NotAloneSyncApp/MenuBarProbeApp.swift" \
    -I "${module_dir}" \
    -L "${framework_dir}" \
    -lNotAloneSyncCore \
    -framework AppKit \
    -framework CoreGraphics \
    -Xlinker -rpath \
    -Xlinker "@executable_path/../Frameworks" \
    -o "${app_dir}/Contents/MacOS/NotAloneSyncProbe"

cp "${probe_dir}/App/Info.plist" "${app_dir}/Contents/Info.plist"

# 让 macOS 将可执行文件、核心库和 Info.plist 视为同一个稳定的 App 身份。
# 优先用本机稳定的代码签名证书：屏幕录制授权按签名身份记忆，
# 证书不变时重新构建不需要重新授权；没有证书时退回 ad-hoc 签名。
signing_identity=$(security find-identity -p codesigning -v 2>/dev/null \
    | sed -n 's/^[[:space:]]*[0-9]*)[[:space:]]*[0-9A-F]* "\(.*\)".*/\1/p' \
    | head -1)
if [[ -n "${signing_identity}" ]]; then
    codesign --force --deep --sign "${signing_identity}" \
        --identifier "com.notalone.sync-probe" \
        "${app_dir}"
    echo "签名身份：${signing_identity}"
else
    codesign --force --deep --sign - \
        --identifier "com.notalone.sync-probe" \
        "${app_dir}"
    echo "签名身份：ad-hoc（每次重建后需重新授权屏幕录制）"
fi

echo "已构建：${app_dir}"
