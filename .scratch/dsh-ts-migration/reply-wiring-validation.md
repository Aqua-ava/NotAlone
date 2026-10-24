# Python候选入口的唯一执行方验证

2026-10-24。候选入口现在可在启动时显式选择唯一RemoteReplyPort；默认仍保持迁移前执行方，主宿主未启用该模式，05生产门禁未解除。旧探索producer及Skill审核仍有其独立迁移任务，不因本补丁静默删除。

`NOTALONE_REPLY_RUNTIME=typescript`要求TS宿主及私有URL/token；配置缺失或所有权冲突关闭启动，运行请求失败不创建Python候选兜底。ReplyService、08候选流程和Assistant continuation复用同一个实例，不再次套Python前台许可。正常关闭及启动中途失败先关薄桥，再停止模型控制；薄桥中断不代表TS物理调用已结算。

按已确认范围移除旧ECNU专用分支，不自动改原配置。六种业务拒绝由实际ReplyService保留原reason，prepare/generate一致；基础设施异常仍传播为服务错误。此处不改资料保存格式、来源或owner/contact隔离，不读取聊天正文或凭据。

根先运行唯一实例及实际拒绝结果最小2/2，再运行wiring7、remote10、ReplyService11，共28/28；独立审查在仓库外实际应用五文件重跑loopback1/1和相关28/28，0剩余发现。晋升测试使用真实模块，原transport里的临时补丁安装器已换成实际业务拒绝断言；网络守卫仅在用例上下文生效，独立验证同进程的socket.connect、环境和允许端口在异常路径也恢复，未安装不可撤销全局audit hook。

在backend目录运行：

```sh
NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=src python -m unittest tests.unit.application.test_reply_wiring tests.unit.application.test_reply_remote tests.unit.application.test_reply_service -v
```

仅合成loopback，无业务库、真实模型、App/微信、打包或推送。Python装配胶水无新增DSH API，固定官方版本仍为`0.2.1-rc.2 / 687f282e8625c6b8d11ff58211a90524be2e4317`；真实官方宿主保留唯一旧后台及随宿主退出的最小用例另行通过1/1。

完整主宿主装配、所有模型物理调用恢复、无模型配置的最终切换行为和真实质量验收仍需验证；组件证据不等于整体替换完成。
