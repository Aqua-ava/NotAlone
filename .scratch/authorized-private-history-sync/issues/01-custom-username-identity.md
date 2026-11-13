# 修复自定义微信号的身份解析

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: none

按 [spec](../spec.md) 与 [ADR-100](../../../architecture/adr/100-authorized-private-history-sync.md) 修复 pinned 只读 CLI 对自定义 `username` 的错误处理：会话解析失败时它把非 `wxid_` 的 `username` 当显示名，并要求执行会写入缓存的 `cache refresh`。本票让稳定定位标识贯穿会话发现、单会话读取、全局事件触发与查询，不引入昵称匹配，也不放宽只读边界。

## 验收

- [x] `sessions --type-filter private` 返回的自定义 `username` 可直接用于 `resolve-chat`、`tail <talker>`、`tail --mode sessions` 事件流与查询，不再要求 `cache refresh`。
- [x] 显示名缺失时可按既有规则回填联系人或备注，但身份判定只使用稳定定位标识，绝不用昵称、备注或显示名。
- [x] 只读补丁不新增缓存写入；`--strict-read-only` 下仍无任何写操作。
- [x] 补丁对应用户提供的 pinned 源重新构建，更新补丁与来源锁记录；合成 fixture 覆盖列表、单读、事件流与查询四条路径。
- [x] adapter 与 CLI 相关单测通过；记录修复前后的命令输出作为证据，真实 24 个失败会话的验收留给 08。

## Comments

2026-10-23：实现完成。修复是在会话解析前先做一次精确会话身份检查：`username` 精确命中 `SessionTable` 时直接返回稳定定位候选，不再进入联系人名称解析或缓存索引分支；联系人库可用时只用于回填展示名与 `verify_flag`，身份判定不使用昵称、备注或显示名。补丁与合成测试哈希已更新到来源锁。

本机只有 Command Line Tools、没有完整 Xcode，官方整包 `prepare-wechat.mjs` 会在 `debugserver` 的 `xcodebuild` 阶段失败；因此按锁定来源单独编译 WCDB 2.1.16 与 CLI，并运行同一 Go 门禁测试，未声称整包组件构建通过。

两轴评审：Standards 初评 4 项判断（测试辅助重复、SQL 表达式重复、静默降级、断言过宽），采纳并修复前两项中的测试辅助与断言，SQL 重复按上游既有形态与低收益保留；Spec 初评指出 `verify_flag` 未参与精确候选分类与“查询/证据”未记录，前者已修复并加合成用例，后者在本票闭环。复审两轴均为 0 项剩余。

2026-10-23 后续接入修复：票 08 发现产品首次连接必需的 `status --include-debug --strict-read-only` 被本票重建 CLI 的命令白名单拒绝。现开放 `status`，保留既有账号 JSON 契约，拒绝用 `--mode` 转入其他诊断入口，并移除状态计算中与账号核验无关的语音解释器探测。严格只读、wxkey／Keychain 禁用与正文读取范围不变；没有修改 Python 适配器的就绪条件。

本轮使用锁定 Go 1.26.5、已编译 WCDB 2.1.16 和相同 pinned CLI 源单独重建，没有运行整包 `prepare-wechat` 或 App 打包。红绿证据分别为：命令拒绝 `notalone_command_disabled` → 状态账号契约通过；合成语音解释器留下文件导致快照失败 → 状态不再调度解释器；`status --mode doctor` 返回成功 → 越界模式返回 `invalid_argument`。合成测试还验证默认隐藏账号、坏密钥及 Keychain 配置不可用、配置／数据库／支持目录内容不变。

验证：`go test -p 2 -run '^TestNotAlone' ./cmd/wechat-cli` 全部通过；Node 真实 CLI 门禁与来源锁 2 项通过；Python `test_setup_probe`、`test_adapter`、`test_global_session_stream`、`test_cli_binding` 共 59 项通过。`go mod verify`、Go／WCDB 归档哈希、锁定原始源码上的 `git apply --check --whitespace=error-all`、源码／补丁／测试镜像及 ad-hoc 签名校验通过。补丁文件的标准上下文前缀会被外层 Git 视为“空格后 tab”，因此仓库差异使用 `git -c core.whitespace=-space-before-tab diff --check`，实际补丁另做严格空白检查。真实账号、开发配置切换与票 08 的正文／历史覆盖验收另行记录，不由这些合成检查替代。

本轮两轴独立审查：Standards 与 Spec 均无发现。首次真实状态对照仍遇到本机权限差异：旧 CLI 同账号可读，新 CLI 的会话身份表探测返回 `operation not permitted`；这发生在正文读取之前，不能归因为 JSON 契约或密钥不兼容。临时仅错误类别诊断已回退并删除，恢复正常构建后重跑 Go 与 Node 门禁通过；系统授权与开发配置结果按后续实测记录，不绕过 macOS 授权。

开发配置实测：最终 CLI 和配套 WCDB 已保存在独立固定开发目录，通过真实 `npm run dev` App 停止服务、保存新启动路径并重新检查连接；App 显示“已连接”仅来自既有账号状态，不能作为实际可读证据。随后在 App 刷新微信会话，显示名单暂无法读取。系统设置中宿主对“微信和其关联 App 共享的数据”的单项访问开关处于关闭，尚未更改；已请求用户明确允许该项系统授权。旧工具保留，未改 TCC、清授权或替换旧执行文件。系统授权决定、真实读取及历史覆盖继续在票 08 记录，本次修复提交不声称这些验收完成。

## Answer

修复后的行为：

- `resolve-chat <自定义username>` 在联系人库存在或缺失时都返回唯一候选，`match` 为 `username_exact`，展示名回填联系人 `remark`/`nick_name`，无联系人时回退到 `username`。
- `tail <自定义username>` 可直接读取该会话文字事件；`tail/watch --mode sessions` 的全局会话事件包含该自定义身份，回传给 `tail` 不要求缓存刷新。
- 已验证自定义账号的 `verify_flag` 参与会话类型判定，与 `sessions` 列表的分类一致；`--type-filter private` 与 `official` 各自返回正确结果。

验证命令与结果：

- 红：新增合成用例后 `go test -run '^TestNotAlone' ./cmd/wechat-cli` 失败于 `自定义username应按稳定标识唯一解析: []interface {}{}`。
- 绿：同一命令在锁定的 Go 1.26.5、WCDB 2.1.16 与重建 CLI 上通过（`ok ... 1.007s`）。CLI `--version` 为 `2.0.1-rc.5`，commit `795071fa0591da5fc2c6ab94a70f22ccd93ef06c`。
- `node --test tests/packaging/wechat-cli.test.mjs`：2 项通过，含补丁/测试哈希与真实 CLI 门禁。
- `python -m unittest tests.unit.wechat_cli.test_adapter tests.unit.wechat_cli.test_global_session_stream tests.unit.front_sync.test_cli_binding`：46 项通过。
- `python -m unittest tests.unit.front_sync.test_cli_pagination_sync tests.unit.front_sync.test_cli_full_sync_engine tests.unit.server.test_sync_host tests.unit.wechat_cli.test_normalizer`：71 项通过。
- `git apply --check --whitespace=error-all` 对新补丁通过；补丁与测试文件镜像与构建目录逐字节一致。

数据处理影响与剩余风险：只读边界、消息范围与存储不变；合成 fixture 全部为匿名数据，未读取真实微信。未完成整包组件构建（缺完整 Xcode）与真实 24 个失败会话验收，后者按票 08 执行；自定义账号在真实微信中的 `verify_flag` 取值与缓存缺失组合仍需票 08 记录。
