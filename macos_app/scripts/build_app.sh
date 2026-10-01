#!/bin/zsh
set -eu

script_dir="${0:A:h}"
app_dir="${script_dir:h}"
repo_root="${app_dir:h}"
build_dir="${app_dir}/build"
app_bundle="${build_dir}/NotAloneApp.app"
module_dir="${build_dir}/modules"
module_cache_dir="/private/tmp/notalone-app-module-cache"
helpers_dir="${app_bundle}/Contents/Helpers"

mkdir -p "${app_bundle}/Contents/MacOS"
mkdir -p "${app_bundle}/Contents/Frameworks"
mkdir -p "${helpers_dir}"
mkdir -p "${module_dir}"
mkdir -p "${module_cache_dir}"

# 后端会直接启动这个 CLI 探针；每次构建主 App 时一并重建并签名，
# 避免 App 使用旧的或 ad-hoc 身份不同的探针。
zsh "${repo_root}/macos_sync_probe/scripts/build_cli.sh"

env CLANG_MODULE_CACHE_PATH="${module_cache_dir}" \
    swiftc -swift-version 6 -parse-as-library \
    -emit-library \
    -emit-module \
    -module-name NotAloneAppCore \
    -emit-module-path "${module_dir}/NotAloneAppCore.swiftmodule" \
    "${app_dir}/Sources/NotAloneAppCore/"*.swift \
    -framework AppKit \
    -framework Foundation \
    -Xlinker -install_name \
    -Xlinker "@rpath/libNotAloneAppCore.dylib" \
    -o "${app_bundle}/Contents/Frameworks/libNotAloneAppCore.dylib"

# 与 Swift Package 使用相同语言模式并收集整个目标，新增视图不会遗漏。
env CLANG_MODULE_CACHE_PATH="${module_cache_dir}" \
    swiftc -swift-version 6 -parse-as-library \
    "${app_dir}/Sources/NotAloneApp/"*.swift \
    -I "${module_dir}" \
    -L "${app_bundle}/Contents/Frameworks" \
    -lNotAloneAppCore \
    -framework AppKit \
    -framework SwiftUI \
    -Xlinker -rpath \
    -Xlinker "@executable_path/../Frameworks" \
    -o "${app_bundle}/Contents/MacOS/NotAloneApp"

cp "${app_dir}/App/Info.plist" "${app_bundle}/Contents/Info.plist"

# 把用户已安装的 CLI 及其运行时动态库复制进 App，随后与主 App 使用同一个
# 稳定的开发签名。只复制可执行文件会让 Finder 启动的 CLI 因找不到
# libWCDB.dylib 立即退出；依赖缺失时不放入半可用的 bundled CLI，让后端
# 回退到 PATH 中的用户安装版本。
cli_source="$(command -v wechat-cli || true)"
if [[ -n "${cli_source}" ]]; then
    cli_source="${cli_source:A}"
fi
wcdb_library_source="${WECHAT_CLI_WCDB_LIB:-}"
if [[ -z "${wcdb_library_source}" && -n "${cli_source}" ]]; then
    for candidate in \
        "${cli_source:h}/libWCDB.dylib" \
        "${cli_source:h:h}/share/wechat-cli/libWCDB.dylib" \
        "${HOME}/.local/share/wechat-cli/libWCDB.dylib"; do
        if [[ -f "${candidate}" ]]; then
            wcdb_library_source="${candidate:A}"
            break
        fi
    done
fi

# 这两个文件是脚本管理的构建产物；先去掉旧副本，避免本次找不到依赖时
# 意外继续使用上一次构建留下的半可用 helper。
rm -f -- "${helpers_dir}/wechat-cli" "${helpers_dir}/libWCDB.dylib"
if [[ -n "${cli_source}" && -x "${cli_source}" \
    && -n "${wcdb_library_source}" && -f "${wcdb_library_source}" ]]; then
    cp "${cli_source}" "${helpers_dir}/wechat-cli"
    cp "${wcdb_library_source}" "${helpers_dir}/libWCDB.dylib"
    chmod 755 "${helpers_dir}/wechat-cli"
    chmod 644 "${helpers_dir}/libWCDB.dylib"
    echo "已打包 wechat-cli 运行时库：${wcdb_library_source}"
elif [[ -n "${cli_source}" && -x "${cli_source}" ]]; then
    echo "警告：未找到 libWCDB.dylib，不把 wechat-cli 放入 App；后端将回退到 PATH。" >&2
else
    echo "警告：未找到 wechat-cli，App 将回退到后端 PATH。" >&2
fi

# 屏幕录制授权按签名身份记忆；优先用本机稳定证书，否则退回 ad-hoc。
signing_identity=$(security find-identity -p codesigning -v 2>/dev/null \
    | sed -n 's/^[[:space:]]*[0-9]*)[[:space:]]*[0-9A-F]* "\(.*\)".*/\1/p' \
    | head -1)
if [[ -n "${signing_identity}" ]]; then
    if [[ -x "${helpers_dir}/wechat-cli" ]]; then
        codesign --force --sign "${signing_identity}" \
            --identifier "com.notalone.wechat-cli" \
            "${helpers_dir}/wechat-cli"
    fi
    if [[ -f "${helpers_dir}/libWCDB.dylib" ]]; then
        codesign --force --sign "${signing_identity}" \
            --identifier "com.notalone.wechat-cli.wcdb" \
            "${helpers_dir}/libWCDB.dylib"
    fi
    codesign --force --deep --sign "${signing_identity}" \
        --identifier "com.notalone.app" \
        "${app_bundle}"
    echo "签名身份：${signing_identity}"
else
    if [[ -x "${helpers_dir}/wechat-cli" ]]; then
        codesign --force --sign - \
            --identifier "com.notalone.wechat-cli" \
            "${helpers_dir}/wechat-cli"
    fi
    if [[ -f "${helpers_dir}/libWCDB.dylib" ]]; then
        codesign --force --sign - \
            --identifier "com.notalone.wechat-cli.wcdb" \
            "${helpers_dir}/libWCDB.dylib"
    fi
    codesign --force --deep --sign - \
        --identifier "com.notalone.app" \
        "${app_bundle}"
    echo "签名身份：ad-hoc（每次重建后需重新授权屏幕录制）"
fi

echo "已构建：${app_bundle}"
echo "前置：仓库根 .env 需含 NOTALONE_DATABASE_URL 与 NOTALONE_OWNER_ID；"
echo "conda 环境 NotAlone 中需已运行 pip install -e（提供 notalone-server 命令）。"
