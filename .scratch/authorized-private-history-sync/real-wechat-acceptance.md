# 真实微信只读验收记录

日期：2026-10-23；代码基准：`23cafb81`；对应[票 08](issues/08-real-wechat-acceptance.md)。结论：未通过完整验收，保留未完成状态。以下只记录真实执行；票 01／05／06 的合成验证不计入本轮真实覆盖。

## 环境和桌面复验

- `cd desktop && npm run dev:status`：`mode=development`，复用已有开发宿主。第一次未设 Conda PATH 时 npm 不可用，补 PATH 后成功。
- 主 Agent 使用 Computer Use 查看管理后台 → 联系人，并点击“重试连接”：从“正在启动 NotAlone／正在连接本机服务”恢复为“尚未连接／启动遇到问题／数据库迁移账本或基线发生漂移”。微信进程在运行；未操作无关聊天界面。
- `NOTALONE_ENV_FILE="$PWD/.env" python -m notalone.startup_diagnostics --migrations backend/database/migrations`（使用 NotAlone Conda Python）：退出 1，`{"code":"migration_history_mismatch"}`。
- 主 Agent 对迁移账本的只读核验：baseline offset 0、账本 104 项、仓库 106 项；已记录的 `104_cli_history_sync_state.sql` checksum 与仓库不同。缺少后续迁移与已有迁移被改变是不同问题，不能通过直接改 checksum 抹去漂移。
- 主 Agent 在本地 Git 对象中按 500～20000 bytes 筛选 10169 个 blob，比对账本 SHA256 未找到原始 104 文件；该有限扫描不能证明其他路径或大小范围也不存在原文件。未修改账本或业务 schema。

## 当前授权与稳定身份检查

数据库连接设置 `default_transaction_read_only=on`、`statement_timeout=3000`，查询仅按配置 owner 的绑定、同步范围、总开关及授权表存在性，不打印 owner 或账号标识。

| 只读聚合 | 真实结果 |
| --- | --- |
| active 微信绑定 | 290 |
| 非 `wxid_` 稳定 locator | 24 |
| 全部私聊范围 | 1 |
| 同步总开关 | 开启 |
| `wechat_history_sync_authorization` 表 | 不存在 |

没有保存历史授权，未执行历史正文读取。当前 24 个与早先报告数量一致，但缺少历史名单，未证明是同一身份集合。

## CLI 对照

以 App 配置的现有 CLI 和票 01 留存的重建 CLI 为两组，未替换配置或二进制。命令通过 Python `subprocess.run(capture_output=True)` 在本机内存解析，stdout/stderr 不持久化；只输出下列聚合。

| 命令／核验 | 配置 CLI | 票 01 重建 CLI |
| --- | --- | --- |
| `--version` | `1.6.25` | `2.0.1-rc.5`，commit `795071fa0591da5fc2c6ab94a70f22ccd93ef06c` |
| `status --include-debug --strict-read-only` | 账号与 24 个绑定的 account_scope 均匹配；检查前后账号一致 | 退出 2，stderr `notalone_command_disabled`，无 JSON 输出 |
| `resolve-chat <稳定locator> --type-filter private --strict-read-only` | 24/24 返回 `tool_error`，24/24 建议 `cache refresh` | 因账号核验失败未执行 |

旧 CLI 首轮状态核对与 24 次解析合计约 0.35 秒；这是元数据检查耗时，**不是历史同步耗时**。随后复查错误类别得到相同 24/24 失败聚合。未执行 `cache refresh`。

重建版拒绝原因可由 `desktop/wechat-patches/readonly-cli.patch` 的命令白名单核实：允许 sessions、resolve-chat、tail/watch、help、version，但没有 status；产品 `backend/src/notalone/server/command.py:271` 的首次连接账号探测调用 `backend/src/notalone/wechat_cli/adapter.py:289` 的 `configured_account`，该方法需要 status。因此版本查询成功和票 01 的合成解析测试均不能证明它现在可接入真实 App。

## 未覆盖和后续

| 必需验收 | 当前结果 |
| --- | --- |
| 首次全历史规模、耗时、存储增量、分页 | 未执行；启动失败，历史授权未落库 |
| 退出重启与断点恢复、历史/实时接续 | 未执行；没有成功运行的历史任务 |
| 关闭总开关、撤销后停读 | 未执行；未更改用户开关或绑定 |
| 来源／联系人删除后不可检索或恢复 | 未执行；未删除真实资料，不用只读查询冒充删除验收 |
| 24 个会话修复后可读 | 未证明；旧版真实解析失败，重建版账号核验被拒绝 |

后续须先单独解决已有迁移漂移：找回可信原始 104 并以新迁移表达差异，或制定带 schema 审计的恢复方案，经既有数据变更授权后执行；不得直接覆盖账本。还需修复并验证只读 CLI 的账号核验契约，确认真实账号和读取能力后再切换配置。产品恢复可用后，完成历史范围明确确认，再逐项续做本票；真实删除验收需明确对象与删除范围。

本轮没有业务数据写入、历史正文读取、外部模型调用或消息发送，没有私人截图入库；没有新增构建、常驻进程或临时正文文件，保留原开发实例与已有资源。没有以未归属的测试库／缓存为清理目标。

## 文档验证

- `git diff --check`：通过。
- 独立 Standards 审查：未发现文档硬违反，代码气味不适用；未另行复验私人运行现场。
- 独立 Spec 审查：未发现记录失实、夸大或越界；业务验收仍部分完成，保留 `claimed`。审查核实生产账号探测与 CLI 白名单的契约缺口。
- `node scripts/check_public_history.mjs --ref HEAD --working-tree`：提交前对基准及当前工作树检查 `issues=0`。本票不改可执行代码，未运行合成测试来替代真实验收。
