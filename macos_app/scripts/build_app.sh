#!/bin/zsh
set -eu

script_dir="${0:A:h}"
app_dir="${script_dir:h}"
repo_root="${app_dir:h}"
build_dir="${app_dir}/build"
app_bundle="${build_dir}/NotAloneApp.app"
module_dir="${build_dir}/modules"
module_cache_dir="/private/tmp/notalone-app-module-cache"

mkdir -p "${app_bundle}/Contents/MacOS"
mkdir -p "${app_bundle}/Contents/Frameworks"
mkdir -p "${module_dir}"
mkdir -p "${module_cache_dir}"

# 后端会直接启动这个 CLI 探针；每次构建主 App 时一并重建并签名，
# 避免 App 使用旧的或 ad-hoc 身份不同的探针。
zsh "${repo_root}/macos_sync_probe/scripts/build_cli.sh"

env CLANG_MODULE_CACHE_PATH="${module_cache_dir}" \
    swiftc -parse-as-library \
    -emit-library \
    -emit-module \
    -module-name NotAloneAppCore \
    -emit-module-path "${module_dir}/NotAloneAppCore.swiftmodule" \
    "${app_dir}/Sources/NotAloneAppCore/BackendConnection.swift" \
    "${app_dir}/Sources/NotAloneAppCore/BackendModels.swift" \
    "${app_dir}/Sources/NotAloneAppCore/FollowSmokeRefreshPolicy.swift" \
    "${app_dir}/Sources/NotAloneAppCore/FollowSmokeControls.swift" \
    "${app_dir}/Sources/NotAloneAppCore/BackendClient.swift" \
    "${app_dir}/Sources/NotAloneAppCore/BackendSupervisor.swift" \
    "${app_dir}/Sources/NotAloneAppCore/SseEventClient.swift" \
    -framework AppKit \
    -framework Foundation \
    -Xlinker -install_name \
    -Xlinker "@rpath/libNotAloneAppCore.dylib" \
    -o "${app_bundle}/Contents/Frameworks/libNotAloneAppCore.dylib"

env CLANG_MODULE_CACHE_PATH="${module_cache_dir}" \
    swiftc -parse-as-library \
    "${app_dir}/Sources/NotAloneApp/NotAloneApp.swift" \
    "${app_dir}/Sources/NotAloneApp/AppModel.swift" \
    "${app_dir}/Sources/NotAloneApp/FollowVerificationControls.swift" \
    "${app_dir}/Sources/NotAloneApp/MainWindowView.swift" \
    -I "${module_dir}" \
    -L "${app_bundle}/Contents/Frameworks" \
    -lNotAloneAppCore \
    -framework AppKit \
    -framework SwiftUI \
    -Xlinker -rpath \
    -Xlinker "@executable_path/../Frameworks" \
    -o "${app_bundle}/Contents/MacOS/NotAloneApp"

cp "${app_dir}/App/Info.plist" "${app_bundle}/Contents/Info.plist"

# 屏幕录制授权按签名身份记忆；优先用本机稳定证书，否则退回 ad-hoc。
signing_identity=$(security find-identity -p codesigning -v 2>/dev/null \
    | sed -n 's/^[[:space:]]*[0-9]*)[[:space:]]*[0-9A-F]* "\(.*\)".*/\1/p' \
    | head -1)
if [[ -n "${signing_identity}" ]]; then
    codesign --force --deep --sign "${signing_identity}" \
        --identifier "com.notalone.app" \
        "${app_bundle}"
    echo "签名身份：${signing_identity}"
else
    codesign --force --deep --sign - \
        --identifier "com.notalone.app" \
        "${app_bundle}"
    echo "签名身份：ad-hoc（每次重建后需重新授权屏幕录制）"
fi

echo "已构建：${app_bundle}"
echo "前置：仓库根 .env 需含 NOTALONE_DATABASE_URL 与 NOTALONE_OWNER_ID；"
echo "conda 环境 NotAlone 中需已运行 pip install -e（提供 notalone-server 命令）。"
