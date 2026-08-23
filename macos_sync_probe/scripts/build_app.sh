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
# 使用本机 ad-hoc 签名，不需要开发者证书，也不会上传任何内容。
codesign --force --deep --sign - \
    --identifier "com.notalone.sync-probe" \
    "${app_dir}"

echo "已构建：${app_dir}"
