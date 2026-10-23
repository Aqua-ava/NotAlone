# Python增量移交组件独立验证

组件包含cli_sync历史单写者、factory/full_sync_engine显式远程选择与控制、incremental_remote RPC适配和incremental_events事件接收器及3个直接测试模块。基于已提交109与接受计数修复，不回退其计数合同。

将候选8文件与HEAD组成的完整暂存树导出到临时目录，不复制其他未提交源码：

- `import notalone.front_sync.factory` 成功。
- `python -m unittest tests.unit.front_sync.test_incremental_remote tests.unit.front_sync.test_cli_history_only tests.integration.test_incremental_events tests.unit.front_sync.test_cli_full_sync_engine`：41/41通过，8.78秒，无跳过。
- 仅匿名合成数据及独立_test数据库；不读取实际聊天，不调用模型；临时快照自动清理。

共享server/app.py、server/command.py、host-plugin.ts、legacy-backend.ts、sync_host.py及官方host测试未纳入。运行时移交启用依赖后续共享宿主注入与App事件路由，本组件提交不代表整票接线及实际App验收完成。
