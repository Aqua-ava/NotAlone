# 腾讯合同独立验收交接

- 状态：固定候选 a61a21407c9395c462e4e68bfeee4628e7e9b15c 的标准/规格均通过；本范围无新增P1/P2。
- 标准/规格分列：report.md；源摘要：source-preflight.json；初始快照：baseline.json。
- 上游固定 6a4bb55ea54834d8265ce52024d3e3c75db30d38，MIT 与四模块摘要相符。
- Tencent清单27项、freeze覆盖26项及budget8项/外部依赖均一致；152项为实现方历史证据。
- 独立执行15个不同用例全绿：contracts4、related8、adoption3；另阶梯single1与上游checker通过。
- 覆盖背景/范围外证据拒绝、统一池来源/条件、owner/contact隔离、E后来源失效、L3增量、撤销/删除。
- 362个源码/SQL/fixture/配置与固定提交对象相同，每执行阶段前后零漂移；见frozen-files.json。
- 预算主测由另一验收会话负责；本侧已配对核provider同步标记与L2finally严格false合同及依赖哈希。
- 精确执行参数、计数、日志摘要在五份*-result.json；verify.py可按--stage定点复现。
- 未重复并发预算/ACK代理试验；unknown提取不重发回归已独立执行。
- 四个自有合成PG库均finally关闭/DROP；真实供应商调用0，真实问题账本未改，日志0700/0600。
- 未读项目.env或私有业务资料，未操作桌面/真实模型/index/提交。
- 仅npm run dev；本验收无需启动App，禁止打包或运行打包版。
- 仅写本目录；生产源码、既有测试与原证据只读。真实质量/App及旧unknown仍由根核回执。
