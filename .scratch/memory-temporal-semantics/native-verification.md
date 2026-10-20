# 开发 App 验收记录

## 票01集成：2026-10-20

- 源码：`641f66e1`；实际 Electron 开发宿主，未打包。
- 复用 `memory_event_updates_fixture.main(mode="manual", page_protocol=True)`，仅隔离合成 PostgreSQL 和受控模型；新建独立 user-data，未连接业务数据库。
- 入口：`npm run dev -- --user-data-dir <本轮隔离目录>`。默认 `dev:status` 不统计自定义目录，另通过同一 `developmentProcesses(project, userData)` 确认一个受监督开发宿主、无 orphaned/packaged。
- 首次启动因未将合成数据库地址传给启动诊断而提示“数据库尚未配置”。正常退出，补齐本轮环境后连接成功；没有绕过诊断。
- Computer Use 实际选择“合成事件联系人”→记忆→展开来源与版本，核对来源聊天时间为 8 月 1 日、安排在 8 月 5 日、保存时间为 10 月 20 日；计划到期仍显示“计划”，没有自动升级已发生。
- 实际切到“待确认”，后续原话对应候选单独显示“已发生”、8 月 5 日来源以及对应发生时段；原人工采纳计划未被静默替换。
- 截图检查了滚动前后排版；没有遮挡事件日期、阶段或来源/保存时间。未保存截图文件。
- 收尾：通过 App 正常退出，开发监督器退出码 0；夹具 `stop` 正常退出，回执 `instance_ok=true, class_ok=true, database_remaining=false`。没有创建浏览器页。
- 限制：本轮只验票01已有日期和事件；新日期精度、条件、时间线更新和完整回复交互待后续集成。合成模型不证明真实模型语义质量，未执行微信采集或外部发送。
- 退出时出现既有窗口销毁后的 `memory:cancel-processing-read` IPC 拒绝日志，退出与清理成功；本次未修改该独立窗口生命周期问题。
