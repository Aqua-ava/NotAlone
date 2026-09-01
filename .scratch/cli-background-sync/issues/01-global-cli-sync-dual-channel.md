# 全局 CLI 增量同步与前台 OCR 双通道

Type: task
Triage: ready-for-agent
State: resolved
Blocked by: none

## 目标

实现 `.scratch/cli-background-sync/spec.md`：首次批量确认 CLI 可见的一对一会话后，NotAlone 运行期间由单一全局 CLI 会话事件流驱动已绑定联系人增量同步；OCR 只报告当前微信前台定位，不再阻塞后台同步。

## 交付行为

1. `wechat-cli` 适配器支持 sessions 模式全局 follow 事件流和基于 baseline/cursor 的一次性正文读取。
2. 后端支持批量列出私聊会话、一次性确认绑定，并为绑定建立 baseline。
3. 后端主同步循环运行 CLI 后台同步与前台 OCR 定位两个独立模块，状态 API 输出两者状态。
4. Swift App 提供批量绑定界面、CLI 全量同步总开关和独立的前台定位显示；旧人工 Follow 验证保留为兜底。
5. 通过脱敏 fake、数据库集成测试、Swift 构建验证，并记录未完成的真实微信冒烟风险。

## 约束

- 只处理 `sessions --type-filter private` 可见的一对一会话。
- 未经用户最后一次批量确认不得创建绑定或联系人。
- 不读取或持久化原始视觉帧，不发送消息，不切换/滚动微信。
- 只提交本任务新增或修改的文件，不触碰工作区已有的 `.scratch` 冒烟日志、网站原型和 `vibe_images/`。

## 验证

实现完成后在 `## Answer` 记录实际运行的单元测试、集成测试和 Swift 构建结果；没有真实微信端到端证据时，明确标记为待人工冒烟而不是宣称可用。

## Answer

已完成。

- 已实现 CLI 私聊会话批量预览、一次性确认绑定、绑定 baseline，以及单一全局 CLI 会话事件流驱动的后台增量读取；全局流不可用时降级为有界轮询。
- 已将常驻同步拆成 CLI 后台正文同步与前台 OCR 定位两个独立通道；OCR/录屏权限异常不再阻塞 CLI 后台同步，旧人工 Follow 验证保留为兼容入口。
- 已补充 026 数据库迁移、同步状态 API、Swift 批量绑定界面和 CLI 全量同步开关；关闭窗口内的消息只前移水位，不写入本地消息表。
- 已通过 685 项 Python 测试、9 项 Swift 测试、Swift App 构建、迁移重复执行和脚本语法检查。
- 尚未完成真实微信端到端冒烟：需要在新 App 中由用户刷新私聊列表、批量确认绑定、开启 CLI 同步并实际切换微信与 NotAlone 验证；未取得这份证据前不宣称真实微信集成已验证。

## Comments
