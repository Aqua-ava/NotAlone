# B501 cleanup-v3 两项 P2 窄复核

结论：原 v2 的两项 P2 在本次 v3 候选中均已修正；本窄 delta 新增 finding **0**。原 v2 报告保留，不改写原运行或历史 graceful=false。此结论不签实际 App、整05、25或切换。

一次性释放：主候选 `candidate/reply-background-public.test.mjs:51` 先消费 pending 并撤销自身 releaseLate 绑定；已结束／destroyed 响应和保存的旧闭包重复调用均无操作。实际 sendEvents 函数、无 socket 的 Node ServerResponse、实际 late 分支和 after-hook 的顺序回归已独立通过，正常 body 先释放后 after 不再重设 header；尚未完成的 SSE 仍能在 after 释放。

独立结束 client：主候选将只读连接数查询放入 `checkClientConnections`，adapter 仅在原 stopChild 阶段末尾追加可选调用（`:41`），受既有 deadline 约束。closeClient 独立只调用 end。query 永挂仍进入 end；query timeout、provider 原异常和 end 原异常均保留；end 永挂也有界失败且不 dispose。未知／异常进程仍继承已审的保留现场分支，未新增杀未知 PID 或绕过删除门槛。共享 helper `6a05fd23` 字节不变。

本次只独立执行新增 `reply-background-sequence.test.mjs` **7/7、0skip**，未重复原14；日志 SHA `014f68c4679b0a181c50263dd2f76f60d3d8162f628506c3c55988b3c70c1042`。源前后 SHA均等冻结 manifest，原14与正式 sendEvents 依赖 SHA匹配。v2源／manifest／patch保持冻结；改动仅两项清理行为与对应纯回归，业务断言未增加变更。

runner `verify-v3.py` SHA `2e6c2c41080f819d104f9f06e1179df591bbc40d161635dd22628b882f5ef704` 仅静态审查：`:12–15` 启动前核三个目标与共享 helper；`:28` 叠加新测试和原 guard，不替换产品算法。原 TS/Python guard 与正式文件及原锁定 SHA相同，官方 host profile SHA同原轮。隔离 env、0700私有目录与原官方 profile 启动方式保持；`:63–68` 仅 cleanup proof=cleaned 删除外层 snapshot，否则保留。没有运行 runner，也没有认证其实际业务／交互执行。

输入 manifest `42fac62207155f4019f45a46f13719fd6b83234089fe0fac4e7a86940c9960ae`；delta `cb2e407c124fef22c8f00d4e75bcdbe53a3c16bf588f19b2bf1cd67aeb90a932`。完整输入及独立日志 SHA见 `b501-v3-input-sha256.json`。SDK、监听/网络请求、PG、App、微信及新业务 pair均0；只写本审查目录 b501-v3 前缀文件，未修改原件、index或Git。
