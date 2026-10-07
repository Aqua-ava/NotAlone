#!/bin/zsh
# NotAlone 机器级安装脚本（ADR-021）。
#
# 只负责机器级事务：安装 Python 依赖、创建本地数据库、按顺序应用全部
# 迁移、构建 Mac 原生探针。旧 Swift 主界面已退役，新 UI 后续单独设计；
# 用户级配置沿用现有 CLI 与受控配置路径，本脚本不读写密钥。
#
# 幂等：已初始化的环境再次运行不会重复建库/重建数据，只补充缺失的
# 依赖、迁移与构建产物；迁移由版本记录保证重跑时不重复执行。
#
# 用法：zsh scripts/install.sh
set -eu

repo_root="$(cd "$(dirname "${0:A}")/.." && pwd)"
env_name="NotAlone"
database_name="notalone_dev"
database_url="postgresql:///${database_name}"

log() { print -r -- "[install] $*"; }
fail() {
    print -r -- "[install] 失败：$*" >&2
    print -r -- "[install] 提示：请按上面的引导修复后重新运行本脚本；脚本可安全重跑。" >&2
    exit 1
}

cd "${repo_root}"

# ------------------------------------------------------------------
# 0. 依赖检查（macOS / brew / conda / psql / swift）
# ------------------------------------------------------------------
log "检查基础依赖…"
[[ "$(uname -s)" == "Darwin" ]] || fail "本仓库只在 macOS 上运行（探针需要屏幕录制权限与前台观察）。"
command -v brew >/dev/null 2>&1 || fail "未找到 Homebrew，请先安装：https://brew.sh"
if ! command -v conda >/dev/null 2>&1; then
    fail "未找到 conda。请先安装 Miniconda（https://docs.conda.io/en/latest/miniconda.html）。"
fi
psql_bin="$(command -v psql || true)"
if [[ -z "${psql_bin}" ]]; then
    log "未找到 psql；尝试安装 PostgreSQL 16…"
    brew install postgresql@16 || fail "PostgreSQL 安装失败；可先执行 brew install postgresql@16 后重试。"
    # postgresql@16 是 keg-only 公式：安装后不会把 psql/createdb 软链
    # 到 brew 前缀 bin。把它的真实路径补进当前进程 PATH，否则后续
    # 所有 psql 调用报 127，被误判为"无法连接"。
    postgres_prefix="$(brew --prefix postgresql@16 2>/dev/null)"
    if [[ -x "${postgres_prefix}/bin/psql" ]]; then
        PATH="${postgres_prefix}/bin:${PATH}"
        export PATH
        psql_bin="$(command -v psql)"
    else
        fail "已安装 postgresql@16 但未找到其 psql 可执行文件；请手工安装后重试。"
    fi
fi
command -v swiftc >/dev/null 2>&1 || fail "未找到 swiftc，请先安装 Xcode Command Line Tools：xcode-select --install"
command -v codesign >/dev/null 2>&1 || fail "未找到 codesign（Xcode Command Line Tools 的一部分）。"

# ------------------------------------------------------------------
# 1. conda 环境与 Python 依赖
# ------------------------------------------------------------------
# 环境可能以自定义路径（conda create -p）注册，只按第一列匹配会漏检，
# 导致重复 create 报 prefix already exists 且重跑永远失败。
if conda env list | grep -E "^[[:space:]]*[^ ]*/${env_name}[[:space:]]" >/dev/null 2>&1 \
    || conda env list | awk '{print $1}' | grep -qx "${env_name}"; then
    log "conda 环境 ${env_name} 已存在，跳过创建。"
else
    log "创建 conda 环境 ${env_name}（Python 3.12）…"
    conda create -y -n "${env_name}" "python=3.12" || fail "conda 环境创建失败。"
fi

eval "$(conda shell.zsh hook)"
conda activate "${env_name}"
log "安装 Python 依赖（pip install -e .）…"
python -m pip install -e . || fail "Python 依赖安装失败；请检查 pyproject.toml 与网络。"
command -v notalone-server >/dev/null 2>&1 \
    || fail "未找到 notalone-server 命令；pip install -e . 后应在环境 ${env_name} 中出现。"

# ------------------------------------------------------------------
# 2. PostgreSQL 本地服务与数据库
# ------------------------------------------------------------------
log "确保 PostgreSQL 服务在运行…"
if [[ -n "${psql_bin}" ]]; then
    :
elif brew services list | awk '{print $1}' | grep -qx "postgresql@16"; then
    brew services start postgresql@16 >/dev/null 2>&1 || true
fi
# 以数据库 URL 判断连接可用性（本地 peer/trust 认证）。
if ! psql --dbname postgres -c "SELECT 1" >/dev/null 2>&1; then
    log "无法连接本地 PostgreSQL；尝试启动服务…"
    brew services start postgresql@16 >/dev/null 2>&1 \
        || fail "PostgreSQL 服务启动失败。请手工执行 brew services start postgresql@16。"
    # 全新首启包含 initdb，2 秒常常不够；按有界重试等待服务就绪。
    connection_ready=0
    for attempt in 1 2 3 4 5 6 7 8 9 10; do
        if psql --dbname postgres -c "SELECT 1" >/dev/null 2>&1; then
            connection_ready=1
            break
        fi
        sleep 2
    done
    [[ "${connection_ready}" == "1" ]] \
        || fail "PostgreSQL 仍不可连接；请检查服务与认证配置。"
fi

if psql --dbname postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${database_name}'" \
        | grep -q 1; then
    log "数据库 ${database_name} 已存在，跳过创建。"
else
    log "创建数据库 ${database_name}…"
    createdb "${database_name}" 2>/dev/null \
        || psql --dbname postgres -c "CREATE DATABASE ${database_name}" \
        || fail "数据库创建失败。"
fi

# ------------------------------------------------------------------
# 3. 按版本记录应用尚未完成的迁移
# ------------------------------------------------------------------
log "检查版本记录并应用待执行迁移…"
NOTALONE_DATABASE_URL="${database_url}" \
    python -m notalone.database_migrations --migrations "${repo_root}/database/migrations" \
    || fail "迁移未完成；请按错误提示与 database/README.md 处理，不要重放历史 SQL。"

# ------------------------------------------------------------------
# 4. 生成/校验 .env（不写任何密钥）
# ------------------------------------------------------------------
env_file="${repo_root}/.env"
if [[ -f "${env_file}" ]]; then
    log ".env 已存在，保留既有配置；不会覆盖或回显密钥。"
else
    log "创建受控 .env（0600；只含数据库连接，凭据与 owner 另行配置）…"
    # 先以受限权限创建文件再写入：直接 cat > 会按调用方 umask 落盘
    # （通常 0644），存在短暂的全局可读窗口。
    (umask 177 && cat > "${env_file}" <<EOF
NOTALONE_DATABASE_URL=${database_url}
EOF
)
    chmod 600 "${env_file}"
    log "已在 ${env_file} 写入 NOTALONE_DATABASE_URL；首次初始化与凭据配置请参阅 README。"
fi

# ------------------------------------------------------------------
# 5. 构建 Mac 原生探针
# ------------------------------------------------------------------
log "构建前台同步探针（CLI）…"
zsh macos_sync_probe/scripts/build_cli.sh || fail "探针构建失败。"

# ------------------------------------------------------------------
# 6. 收尾引导
# ------------------------------------------------------------------
print
print "──────────────────────────────────────────────────────────"
print "[install] 完成。"
print "[install] Python 后台、数据库与 Mac 原生探针已准备。"
print "[install] 旧 Swift 主界面已退役，新 UI 尚未实现；当前 CLI 使用与首次初始化见 README。"
print "[install] 已知前置：需要微信桌面版、自装 wechat-cli、探针屏幕录制权限（见 README）。"
print "──────────────────────────────────────────────────────────"
