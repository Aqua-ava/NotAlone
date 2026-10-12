# 持续目标：新21窗基线仍因V读超时终止

按[已冻结预注册](goal-memory-20261013-baseline-after-timeout-plan.md)和Root最终核验，仅执行`ae0add54-7f6e-4033-b1e6-37e3a400748f`一次。实际driver用时**204.917180秒**，进程exit1；真实HTTP尝试**2**：E取得200，V在SDK180秒、max_retries0下`read_timeout`，没有重试或V响应。持久closed2/42，剩余**40永久关闭**，不补跑、不换UUID复开、不挪到其他run。

当前基线仍**无效**：21固定窗中A01技术未知1、未运行20、正式raw/full审核0；没有有效覆盖率、accepted质量或原票通过成绩。原程序空facts是本批技术失败的结果，不算成功none，也不能把未运行窗删掉。完成收据可核、capture_gaps空、cleanup_error_codes空、receipt/records错误均null，plan_complete=false、quality_certified=false。原技术6、旧基线4、本轮V诊断1及此次2累计**13次真实尝试**，其中9个200响应，4次V读超时的远端完成情况未知；四个driver累计实际**569.672902秒**。这些累计不含旧已关闭历史实验或本机App/Mock流量。

## 实际契约及定位

外部`baseline-after-timeout/manifest.json`的实际冻结键是`timeout=180.0,max_retries=0`，SDK与双HTTPX同值；原每HTTPcontract和source freeze生效，供应商/endpoint、ecnu-max、thinking、temperature、E/V提示和Gold没有改变。请求`request_model=ecnu-max`，此次E服务报告alias `deepseek-v4-flash`，不等于认证实际权重身份。13次里本次不是先前HTTP500复现：只取得一个200，然后读超时。

实际E请求正文规范SHA`9dae754df11b5ee54bceb49c7a4b56de82f4e8547b85c7219d6206c80696c789`；实际V正文规范SHA`d54e5ca3b861edc035d6d9322983e1f1ae7a21298a5fc6712ef803546372e30f`。后者与[此前SDK180成功诊断](goal-memory-20261013-V-diagnostic-result.md)载荷`1ed50f65…`不同，因为新E的可见字段改变；不能把“一次旧载荷98.8秒成功”推成“当前全部V调用可靠”。未读或保存新V内部思考，没有有效V响应可评分。下一步技术探针须固定本次d54载荷，并有新预算/期限/停止方案，不能拿关闭的40继续。

## E-only事后定位

V失败未触发正式两阶段回调。另在`baseline-after-timeout-fragments/`建立明确的事后E-only视图、显式14字段检查和manifest；它不属于正式audit，不能签accepted/full或放行。

实际1条E候选同时忠实保留未知第三人“不是仓库管理员”及“在采购部”，两个必需命题raw语义2/2，无重复、额外人物或错误否定归属。14字段齐备，12通过：text、category=relationship_note、subject=contact、topic=work、单target来源、confidence0.8、risk=[]、双null、assertion_status=reported、literal及身份未知备选。两项确定失败是`speech_act=correction`（Gold report）以及interpretation_reason声称“纠正此前说法”；固定窗只有一句，没有此前说法依据。两命题**完整E契约0/2**，不能凭类别/标签部分改善或未来V=supported补分。结构化检查调用既有pure raw-validator通过只证明审核格式与绑定有效，不认证语义。

资料全部来自本次公开合成A01；没有私人聊天、联系人授权扩大、业务库或生产默认放行表变化。固定样本与门槛未删改，原21/28分母继续保留。E-only分类/状态比旧片段有所变化是新的模型输出观察，不修改历史失败。

## 证据与清理

- 外部根目录`/private/tmp/notalone-memory-goal-20261013-ac04d687/`0700；本次`baseline-after-timeout/`、`baseline-after-timeout-fragments/`0700，所有JSON0600。原所有plans/index/failed records及未运行位置保留。
- `baseline-after-timeout/{manifest.json,completion.json,run-result.json,run-summary.json,terminal-metadata.json}`；完成收据SHA`2493614e76d9b90e57a89343fe44d15025887ac485b06569b44a29c287fb523b`，包含不可变21窗终态和持久闭账2。
- 独立持久计数位于`/Users/local-user/.notalone-memory-evaluations/ae0add54-7f6e-4033-b1e6-37e3a400748f/budget.sqlite3`。不删除SQLite、closed/claimed或记录文件，不将留存的in-flight.lock文件当作仍在工作的OS锁。
- `baseline-after-timeout-fragments/{00-A01-raw.view.json,00-A01-raw.review.json,fragment-manifest.json}`；视图内raw证据规范摘要`283e19f0feb0230b0a40bae679b97185ff4408cbbad1325e31c3d9ed81209158`，完整E-only视图规范摘要`6e30f8e5d8e35509c7f34ebf3dfbd7b51be6a5d1203f540c026d500f642697d3`（用于新诊断bundle绑定），仅公开E，不读V或改变原run-result。
- 补证工具第一次在写好E-only视图后误找`frozen-config.json`，FileNotFound保留为工具执行失败；按实际record-store改读`manifest.json`后核实timeout180/0。一次字段检查误用入口参数名request_timeout_seconds返回null，也明确纠正为冻结键timeout。两者不冒称产品失败、HTTP新调用或参数落盘缺失。

统一执行会话20775已exit1，原评测入口finally关闭sync/async客户端、durable budget及收据。没有新的后继模型阶段、桌面操作、发送或业务数据删除；新V技术诊断另行预注册，未经最终冻结不会创建预算或发送。原07/core/03质量验收继续未完成，默认放行表保持空。
