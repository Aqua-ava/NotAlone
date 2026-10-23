# 主协调独立验证增量交接端口

2026-10-24，在backend目录执行仓库规定的unittest：
`python -m unittest tests.unit.front_sync.test_incremental_remote tests.integration.test_incremental_events -v`

使用NotAlone Conda解释器，15/15通过，5.246秒。包括取消后无自动重连/迟到enable重开、旧开关写入拒绝、scope失败投影、关闭失败仍清理历史、显式恢复；真实合成PG核对账号变化/来源删除/关闭/解绑后晚事件忽略，原事件总线与任务/学习端口仅接收元数据。测试清理本轮合成库，无真实资料或模型调用。

首次误用pytest，环境未安装该模块，没有执行任何测试；随后核对工程工作流28–33行改用unittest，未安装额外依赖。

此结果仅覆盖已经落盘的两个模块，不表示官方宿主同步循环通过；19在临时官方profile集成仍遇503并自行定位，App验收尚待解锁。
