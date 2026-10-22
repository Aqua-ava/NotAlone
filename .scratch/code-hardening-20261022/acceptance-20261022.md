# 真机验收记录（2026-10-22）

## 环境
- macOS 本机；`cd desktop && nohup npm run dev` 热更新实例（`dev:status` mode=development，supervisor pid 3898），App 窗口「NotAlone · 管理后台」，界面显示「已连接」，沿用现有本地数据库。
- Computer Use：accessibility / screenRecording granted。Electron 渲染层 AX 树只有窗口控件，正文操作使用窗口坐标点击 + 截图目检；vision-tools 不可用，未使用 OCR。
- 未发送任何外部消息；未执行撤销、删除、确认、导入等写操作；仅只读导航。

## 结果
1. **启动与首帧（05）**：联系人页、记忆页正常渲染，没有出现「资料状态暂时无法读取」等首帧错误；强制读取失败路径未注入。
2. **记忆 UI 接线（15）**：选择真实联系人后，「版本历史」可展开，渲染「联系人经历与关系变化」概览（资料集合修订、整理时间、空状态正确）；「主题资料」可展开，渲染 LayeredMemoryPanel（状态、已整理计数、更新状态、整理管理、管理底层联系人记忆入口）。`manageLayeredMemory` 生产入口可见；未点击撤销自动更新或删除。
3. **同步状态（02）**：`GET /api/sync/status` 返回 `health: {"healthy": true, "failure_code": null, "failed_at": null}`，`sync_enabled: true`，`phase: active`。
4. **Skill 文件健康投影（09）**：`GET /api/runtime/status` 返回 `skill_files: {"state": "ok", "pending_working_copies": 0, "pending_cleanup_files": 0, "failures": []}`，无 `degraded` 项。
5. **页面自动化对照**：`test:pages --case memory-reading` 与 `--case contact-relationship-overview` 在当前 HEAD 与基线 `c41c4200`（临时 git worktree）上以相同断言失败（既有页面测试缺口），不是本轮改动引入；因此不把它们当作本轮验收依据。

## 未覆盖
- 微信前台/OCR、异步回复准备取消（06）、导入 deferred（03）、回复生成与回执（04）、4096 补充上限输入（07）未在真机走完整交互，仅有单测/集成覆盖。
- 强制首帧读取失败（05）未注入故障。
- 未做推送、打包、签名或发布验收；未改动任何真实资料。

## 清理
- 临时 git worktree `/tmp/notalone-baseline` 已移除；含真实联系人信息的 Computer Use 截图 artifact 已删除；页面验收临时证据目录已删除。
- 开发 App 实例保留运行（`dev:status` pids=[3898]），方便继续手工验收；需要退出时正常关闭窗口即可。
