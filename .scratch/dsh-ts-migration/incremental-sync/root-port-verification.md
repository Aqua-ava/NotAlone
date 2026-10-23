# 主协调独立验证增量交接端口

2026-10-24，在backend目录执行仓库规定的unittest：
`python -m unittest tests.unit.front_sync.test_incremental_remote tests.integration.test_incremental_events -v`

使用NotAlone Conda解释器，15/15通过，5.246秒。包括取消后无自动重连/迟到enable重开、旧开关写入拒绝、scope失败投影、关闭失败仍清理历史、显式恢复；真实合成PG核对账号变化/来源删除/关闭/解绑后晚事件忽略，原事件总线与任务/学习端口仅接收元数据。测试清理本轮合成库，无真实资料或模型调用。

首次误用pytest，环境未安装该模块，没有执行任何测试；随后核对工程工作流28–33行改用unittest，未安装额外依赖。

此结果仅覆盖已经落盘的两个模块，不表示官方宿主同步循环通过；19在临时官方profile集成仍遇503并自行定位，App验收尚待解锁。

## 正式工作树官方profile追加验证

19应用共享接线后，根在backend-ts目录执行`node --test test/sync-incremental-host.test.mjs`：3/4通过，18.11秒。基本公开开关/历史增量入库/原SSE/双进程唯一职责/认证链路通过；挂起tail时revoke和shutdown通过。disable用例失败于“关闭/撤销必须有界排空”的小于5秒断言（整个用例8.93秒，不能把含初始化的整例时间冒充关闭时长）。

失败已交19按最小单例定位，不放宽时限、不改前台排空保证。该轮退出码1，不能宣称增量官方集成全部通过。测试仅合成PG/CLI，无App或模型。

关闭反例修复后，根独立执行`node --test --test-name-pattern="挂起增量读取时disable" test/sync-incremental-host.test.mjs`：1/1通过、0跳过，整例3.13秒；测试实测controlElapsed与totalElapsed均69毫秒，原小于5秒阈值未放宽，迟到消息未保存。19将认证后的取消前移到旧控制锁等待之前；其余最终组合回归仍由19完成。公开历史检查曾发现另一会话未跟踪red.log的本机路径，已由作者脱敏；根复扫24cbe5ee时issues=0。

## 最终官方模块独立复验

同目录执行`node --test test/sync-incremental-host.test.mjs`，4/4通过、0跳过，12.02秒。实测挂起读取的disable60ms、revoke85ms、shutdown681ms，全部保持原小于5秒界限；模拟退出时吐出的迟到消息未入库。基本公开HTTP/原SSE/唯一读取职责/私有认证同轮通过。仍未覆盖待集成109删除抑制或实际App，19不因此resolved。
