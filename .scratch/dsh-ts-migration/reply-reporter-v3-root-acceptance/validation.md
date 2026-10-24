# 回复对比报告器 v3 根验收

在08323078基线上精确接收两个正式路径：reporter 70fc72f2、原测试6746abf0；单补丁85c22144。根核作者46件、Standards 8件、Spec 32件及两正式基底/七只读依赖，最终两轴0发现；原三类元数据正文泄漏P2和早期timing问题不删除或改写。

根主树依阶梯运行：`node24 --test --test-reporter=tap --test-name-pattern=出口修复 backend-ts/test/reply-comparison.test.mjs` 8/8、0skip；同文件完整78/78、0skip；`node24 backend-ts/node_modules/typescript/bin/tsc --noEmit -p backend-ts/tsconfig.json` exit0/0诊断。执行前后两正式源与七依赖SHA一致，全部根日志原始/分享字节相同，自有仓外冗余日志已清。根接收前两次元数据包装预检错误分别是状态短名和旧目录假定，均发生在写源/执行前，明列于incoming-verification，不冒充产品失败。

报告按合同投影usage/cost/checks、价格/版本、评审、来源与阶段等容器；多余请求/调试正文只留完整输入，合法basis/reason保留，非法已知数值及来源矛盾仍先拒绝。输入/output/runtime/subject摘要始终绑定完整原证据。性能门沿原协议仅用最终持久结果延迟；首事件/首token单独报告观测能力，非流式旧臂不被要求伪造token时刻。96分母、统计/评分门槛、usage算法与两个false认证保持。

只处理本机合成离线材料，HTTP/SDK/PG/真实模型/App/微信0；不读私人资料、凭据或项目.env，不改DSH核心/插件/API、默认Python回复与其他生产行为。不接收实验8路径hardcoded覆盖，不签05、真实质量、usage耦合修正或最终切换。多attempt source/caller/盲整包/正式fixture另候选，尚未接入；后续必须以本正式reporter字节作delta。仅本地提交，不push或打包。
