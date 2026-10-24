# 过渡读取责任声明校正

实际App复核发现 `/api/runtime/status` 仍沿旧映射把全部微信正文读取标为Python，而官方集成已验证增量由TS、历史由Python执行。共享宿主现在声明 `wechatBodySync=split`，并分别提供 `wechatIncremental=typescript`、`wechatHistory=python`；不改变读取执行路径。

固定DSH版本与官方profile沿用整合记录。以 `0a0e29c7` 已提交源码构造隔离树，运行 `verify-integrated-host.py --incremental-ownership`：公开开关/事件/原消息用例1/1及严格类型检查通过（3.763秒）。同一用例同时断言声明字段与实际CLI父PID分别属于TS宿主/Python进程，未用静态字段断言替代执行责任验证。

覆盖文件前后摘要记录于 `integrated-ownership-source-hashes.json`；只有状态声明、对应断言和验证选择器变化，未重复已通过的13项整合测试。数据仅合成独立库，未启动额外App或调用真实模型。
