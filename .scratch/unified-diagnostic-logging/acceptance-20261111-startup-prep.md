# 启动验收准备（2026-11-11）

- 本记录由 01 准备 Agent 独占；不修改 01／02 Answer，不操作 App，不创建第二个开发实例。
- 开工 git status 仅见原三处 WIP；未还原、暂存或提交它们。这里只创建 ignored 记录与本轮私有临时 helper，无需制造本地提交。
- 新 observer 根通过 `/tmp/notalone-startup-acceptance-root` 指向，pointer 0600；根、phases、screenshots 均 0700，私有配置及脚本均 0600。准备完 phase=0、截图=0。
- 私有配置只供 helper 内部使用，不回显、不进入统计；握手文件只取 stat，不读取 token／正文。账本只提取数字 parentPid／childPid，不解析或保存 nonce／home。

## 已查证的正式接口

- `desktop/scripts/dev.mjs:82`：唯一正式启动为 spawn Electron，参数含 `--notalone-dev`，stdio 含 IPC；本 helper 的唯一产品启动命令仍是 `pnpm run dev`。
- `desktop/scripts/development-app.mjs:21` 与 `desktop/src/main/development.ts:9`：真实 ready 消息是 `notalone-dev-ready`，observer 只识别该固定类型，不记录其他 IPC 载荷。
- `desktop/src/main/index.ts:65`：无显式 user-data-dir 时沿用本机应用默认资料根；`desktop/src/main/startup/diagnostics.ts:63` 将开发握手定位至 managed/sqlite-backend.info。
- `backend-ts/src/launch.ts:140`、`:149`：DSH spawn 后原子写入含 parentPid／childPid 的所有权账本；backend 耗时取该文件 mtime 至握手 mtime，不读取握手文本。
- `desktop/scripts/development-lease.mjs:8`：监督器 socket 基于项目路径散列；helper 仅按现有只读探测协议核验，无删除租约或杀进程动作。

## 操作接口（由 Root 执行）

- `observer_root=$(cat /tmp/notalone-startup-acceptance-root)` 后，先亲读 observer.cjs、launch.mjs、summarize.mjs；不要回显 private-config.json。
- Root 用 CUA 正常退出当前 App。首轮 `node "$observer_root/launch.mjs" on 1`；之后按 off 1、on 2、off 2 等交替，直到每组至少五次。
- 每次 sample 必须与已保存的诊断开关一致；helper 不修改开关，不自动退出 App。重复成功 sample 会拒绝；失败重试使用全新 UUID phase。
- helper 拒绝开发／打包／孤儿 App（含其他工作树），拒绝活动监督器、遗留后台文件及其他 NODE_OPTIONS；不杀未知进程。
- 就绪等待最多 45 秒；超时只报告固定原因码并保留现场，仍由 Root 通过 CUA 正常退出。
- mainReadyMs 是主进程 spawn 至 ready IPC 的单调耗时；backendLedgerToHandshakeMs 是 childPid 账本至握手的文件 mtime 差；mainToBackendReadyMs 是 main spawn 至握手。
- ready 仅表示上述两个观察点均获得且 backend PID 尚存；最终 App 已连接及设置状态由 Root 另作 CUA 核验。
- 纯统计写 metrics.jsonl，仅固定 mode/sample/phase、数字 PID、原因码及耗时；原始 stdout／stderr 不保存。
- 截图单独放 `$observer_root/screenshots`，每个图片文件设 0600，不进入仓库。
- `node "$observer_root/summarize.mjs"` 输出两组 n／mean／p50／p95；每组 n≥5 才标 complete。
- 最后一轮先 CUA 正常退出并核对监督器结束，再用普通官方开发入口启动；确认无进程再引用 observer 根后才清理，不提前删除 hook。

## 验证与隐私规格

- 三个 helper `node --check` 均退出 0；`launch.mjs check on` 实际返回 `existing_instance`／退出 1，证明已有实例拒绝生效，没有启动 App。
- `git check-ignore architecture/current/privacy-deletion.md .scratch/unified-diagnostic-logging/acceptance-20261111-startup-prep.md` 退出 0，命中两路径；`git ls-files --` 对两文件输出为空。两者不进入提交。
- 第 4 项无需改文档：privacy-deletion.md:168 已列编号／固定原因／耗时及白名单、无正文且仅本机；:170 规定按日清理和最多 14 天；:171 规定一键清除与在途队列协调；:172 规定自然到期及联系人前缀过滤，碰撞前缀一并清除；:173 账号清除；:174 保留期、控制预算、失败不可假报成功。
- 因上述四项已具备，本轮没有为凑改动编辑隐私规格。未读取真实库、未触发模型／网络、未打包，也未修改生产或测试代码。
