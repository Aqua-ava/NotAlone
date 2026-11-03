# 显式选人后继续微信跟随验证（2026-11-03）

按 [ADR-158](../../architecture/adr/158-contact-selection-keeps-foreground-follow.md)移除独立手动模式、`manualInput` 状态及 `foreground:resume` 桥。显式选择仅确认本次对象，保留自动观察调度；新的有效观察自动更新对象。失败或范围失效清除本次资格和宿主确认标记，不删除既有请求引用的确认记录。

## 自动检查

- 回归先运行 `cd desktop && node --test --test-name-pattern='显式选人不停止' tests/manual-foreground-resume.test.mjs`，修改前失败（观察次数为 0，预期 1），修改后通过。
- `cd desktop && pnpm run typecheck` 通过。
- `cd desktop && node --test tests/manual-foreground-resume.test.mjs tests/foreground-confirmation-binding.test.mjs tests/foreground-latency.test.mjs tests/manual-confirm-session-recovery.test.mjs`：40 项通过。包含真实 `ContactSession` 与公开桥接的合成联系人切换，覆盖旧观察迟到、同人及跨人接管、确认标记清理、失败撤销、焦点暂停、技术退避与已有讨论恢复。
- `cd desktop && NOTALONE_TEST_CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test tests/foreground-recovery-view.test.mjs tests/contacts-history-view.test.mjs`：7 项通过。验证无模式及恢复按钮、选人提示、超时撤销资格、后续成功切换另一合成联系人和联系人页入口。
- `cd desktop && node --test tests/sync-status-recovery.test.mjs tests/helper-shortcut-window.test.mjs`：19 项通过，补查同步状态恢复、快捷键小窗和宿主焦点生命周期。相关自动检查合计 66 项通过。
- `git diff --check` 通过。两位协作 Agent 分别独立检查身份、异步及用户需求，均未发现阻断问题。
- 提交前 `node scripts/check_public_history.mjs --ref HEAD --working-tree` 检查完整可达历史及当前工作区，`issues=0`；提交后再次执行同一检查。

上述使用合成资料和受控传输，不是实际微信 OCR 成功率或真实模型质量验证；未修改原生 OCR 算法、输入范围或分数规则。

## 开发实例及 Computer Use

- 复用当前项目 `pnpm run dev` 热更新实例，改前及改后 `pnpm run dev:status` 均为 `development`；未启动或制作打包版。
- Computer Use 读取实际输入小窗，看到“本次联系人已由你选择；切回微信后自动识别当前会话”，模式及恢复按钮已经消失；助手获焦仍显示前台采集暂停。
- 已读取正在运行的微信窗口。将微信置于前台的桌面操作调用被工具中止，未完成本轮真实微信切换与自动关联验收，不将该项记为通过。实际 OCR 及完整检索生成效果仍须单独核验。
- 未点击生成、调用外部模型或发送消息；未修改读取授权、联系人稳定身份或聊天资料。未将联系人名称、正文或截图保存到本记录。

本轮未新增运行实例或独立编译缓存；输出卷和临时卷任务前后可用空间均约 97 GiB。保留正在使用的热更新输出及其他任务既有资源，没有终止或删除未知进程和文件。
