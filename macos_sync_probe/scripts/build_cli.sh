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

echo "已构建：${build_dir}/notalone-sync-probe"
