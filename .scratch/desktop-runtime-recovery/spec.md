# 正常环境同步恢复与旧库升级边界

Type: task
State: resolved
Triage: ready-for-agent

## Problem Statement

用户要求沿用本机自主运行与验证目标。上一轮已修复启动和合成资料闭环；普通环境的 115 个已确认绑定中，50 个后台补齐失败、65 个保持暂停。业务库缺少迁移账本，尚不能验证来源删除升级。

## Solution

先在已确认范围建立最小只读 CLI 反馈回路，不显示或持久化 CLI 返回的聊天正文、联系人名、定位标识和凭据。区分底层读取失败、空会话与覆盖不完整，再沿用既有适配器和补齐接缝修复可确定的缺陷。旧业务库升级方面仅做系统目录与历史迁移核验，形成可审查的升级路径；实际业务迁移另需明确授权。正常 App 仍按现有确认范围和同步总开关运行并保存同步状态。

## Implementation Decisions

- 不改变联系人或会话绑定身份，不自动重新绑定，不恢复用户暂停的补齐范围。
- 诊断 CLI 仅针对当前 active 且属于已配置 owner/账号的确认绑定，遵循既有 cursor 或 baseline，并尽量限定返回 1 条；输出仅保留错误类别和计数，不向模型服务发送私人资料。
- 沿用原生 App、CLI 和既有数据库端口；不增加外部发送能力、权限或后台自动化。
- 代码修复只在根因证据明确且能在既有公开接缝回归时实施；旧库不猜测基线、不重放历史 SQL、不手写迁移成功账本。
- 本地 CLI 的失败样本无游标、有 baseline，当前会话仍唯一可解析；已有游标对照读取成功。仅识别已观察到的消息表缺失错误模板，返回 `cli_message_table_missing` 并归为覆盖无法确认；不产生空消息成功、不推进游标或扩大绑定范围。
- 同步管理顶部复用现有安全失败说明显示最近读取问题，避免已确认会话长列表遮挡覆盖异常；详细补齐卡片继续保留原有计数和控制。

## Testing Decisions

- 真实 CLI 1.6.20 的一个失败绑定已连续两次复现非零退出，结构化 `tool_error` 指向消息表不存在；错误原文和定位标识不进入规格。
- 逐项验证本地无消息表、过期定位、缓存/数据库不一致、游标不兼容四个假设，不把读取失败折叠为成功空结果。
- 复现后在 CLI/补齐公开接缝先补 red 测试，修复后运行最小回归，再运行完整相关验证并分别检查 Standards / Spec。
- 复用 `LocalWechatCli.tail` / 命令 runner，以及 `CliBackgroundSync.cycle` / 既有合成存储端口；测试错误不泄露内部详情，补齐不被误标完成，其他已确认联系人仍可同步。
- 旧库升级方案在仅含合成资料的隔离库验证；业务库只读审计不构成升级成功。

## Out of Scope

未经明确确认的业务库迁移、业务来源删除、绑定改名或身份重选、未确认或群聊正文读取、私人资料模型外发、微信发送、远端 Git 与部署。

## Answer

CLI 适配器与补齐状态修复已完成；旧库结构未升级，升级审计仅只读。正常 App 已将 50 个原有失败状态保存为覆盖无法确认；升级路径和隔离演练见 [旧库升级方案](migration-plan.md)。

- CLI 1.6.20 的失败样本两次复现同一消息分片缺表模板；会话仍唯一可解析，失败绑定无 cursor、有 baseline。另一个已有 cursor 的已确认绑定严格只读 `tail --limit 1` 成功。上述结果证明特定读取失败，不证明该联系人没有历史消息。
- 新分类仅识别结构化 `tool_error` 的两个完整已知模板，内部表名、路径、stderr 不进入错误说明。错误进入 `incomplete`，不写入成功空消息、不推进游标，未知模板仍返回通用失败。
- 真实运行状态：全局流 active，115 个原有确认绑定；50 个补齐为 `incomplete / cli_message_table_missing`，65 个暂停记录保留，失败计数为 0。完成计数仍为 0；不能宣称历史覆盖完整。
- 原生实机画面已确认同步管理顶部显示“CLI 未找到该会话的本地消息表，无法确认覆盖范围”。电脑操作接口的滚动返回 `noWindowsAvailable`，App 窗口与进程实际仍在；顶部安全摘要使该原因无需滚动即可看到。实机截图未作为仓库证据保存。
- 两个公开接缝先 red 后 green；最终相关回归 54 项通过。Python 全量 1000 项通过、3 项专用评测跳过；`macos_app` 22 项测试通过。App 原生构建及 App/CLI/WCDB 严格签名核验通过；文案调整后重跑 54 项相关测试，顶部摘要加入后再次通过 22 项原生测试、构建与签名核验。
- 旧库与 001–035 参考结构比对：33 表、341 列、233 约束、85 索引；仅来源类型约束不同，迁移账本缺失，036 的删除任务约束也未具备。当前 owner 的消息来源范围、水位和记忆来源契约聚合核验无异常；这不证明历史 SQL 已连续执行。
- 合成旧库演练确认无账本保护、手动记忆与删除请求拒绝时事务回滚；模拟约束补齐后，3 项现有 HTTP/Worker 公开接缝集成测试通过。业务库没有应用这些 SQL，也没有伪造迁移记录。
- `code-review` 的 Standards 与 Spec 两轴各 0 项可操作发现。未改变绑定、暂停范围或授权；未向模型服务发送私人资料，未发送微信消息，未执行远端 Git。
- 当前普通 owner 从本目标启动时刻起的项目模型出站台账新增计数为 0。实机最终保持原有侧栏和同步总开关，App 继续运行。

实际验证命令使用 Conda `NotAlone`：

```bash
NOTALONE_DISABLE_DOTENV=1 python -m unittest tests.unit.wechat_cli.test_adapter tests.unit.front_sync.test_cli_background_sync -q
NOTALONE_DISABLE_DOTENV=1 NOTALONE_TEST_DATABASE_URL=<隔离_test库> NOTALONE_BACKEND_INFO=<仓库外测试握手文件> python -m unittest discover -s tests -q
cd macos_app && swift test -q
zsh macos_app/scripts/build_app.sh
codesign --verify --deep --strict macos_app/build/NotAloneApp.app
codesign --verify --strict macos_app/build/NotAloneApp.app/Contents/Helpers/wechat-cli
codesign --verify --strict macos_app/build/NotAloneApp.app/Contents/Helpers/libWCDB.dylib
git diff --check
```

构建使用原有签名 CLI/WCDB 的受限临时副本；全量测试清除了模型凭据并使用独立握手文件。剩余工作为 CLI 本地覆盖限制与待明确批准的旧库接管，均不由本轮错误分类修复消除。
