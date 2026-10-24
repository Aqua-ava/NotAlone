# 19 带数据父丢失永久回归根验收

在9ed7770d主树只接收parent-loss专属测试及helper两路径，patch ebf33403，执行字节与作者冻结5e649e6f/4f857a97一致；复用既有createStorageFixture、真实launchDsh、锁定官方profile/Legacy与进程身份，不改生产或公共fixture。

根执行 `node --test --test-concurrency=1 --test-reporter=tap backend-ts/test/sync-incremental-parent-loss.test.mjs`：1/1、0skip、约10.04秒。带1条消息时仅SIGKILL本轮已核身份helper，自然子进程停读、原同库/路径自动恢复、原UUID/授权/baseline/cursor保持；规范消息1、合法来源2、派生receipt1、模型任务0。正常退出清理6个自有进程、隔离库/目录/锁/profile/socket，emergency=false，共享PG保留。只核最小新case，不重复旧suite。

独立四文件审查只在另一reconnect fixture发现失败清理P2；本parent-loss两文件无Standards/Spec阻碍。根因此仅接收本对，重连修复在独立scratch进行，未吞掉或改绿该P2。原19签收与原probe/RED不改。

仅本机合成PG/假CLI；真实模型、App、微信、签名、安装及打包均0，不声称真实Electron崩溃或20追赶。根raw日志与分享日志逐字节同SHA，保留test.log原字节并清除自有仓外冗余临时副本。精确源/命令/日志与peer摘要见accepted-manifest.json。仅本地提交，不push。
