# 公开实测失败对应的最小记忆提示修复准备

真实红反馈见 [最后基线结果](goal-memory-20261013-baseline300-result.md)：A01/A03备选补未给角色，A02恢复人物却缺上下文引用并混用历史／未来字段，A04暂时要求丢限定，A05历史经历被写近期状态和消息日有效起点，后者在原评测理想三门出现bad_auto并安全停止。全部原Gold、难例、失败、16unrun和闭账余32保留，不将V supported或旧matcher判passed当完整正确。

Root解除C最后47项短暂源码冻结后，本片只修改 [E提示](../../backend/src/notalone/memory_extraction/adapters.py) 和 [V提示](../../backend/src/notalone/memory_extraction/verification_adapters.py) 两个原system常量：恢复人物／物品／必要限定确需上下文时须引用该来源，未知备选只声明不能定位而不猜职业／亲友／事项；已收到邀约、本人参与亲友借赠等已发生经历与未来安排／当前状态分开，来源观察日不是历史事件开始；值得保存的临时关系要求保留“先／暂时”及观察点，不升级长期taboo。V沿原来源范围逐项核这些缺陷，遗漏必要上下文时uncertain/disconnected_context；澄清原本人参与历史经历可assertion/asserted，纯第三方仍须转述标签，不因出现亲友就机械要求所有事件reported。没有按caseID分支或对难例绕过规则。

已核 `domain-data`、`pragmatic-interpretation`、`core-flows`、隐私及ADR-002/005/033/036的现行修订：只降不升核验、来源范围、原时间政策、三个安全门和默认空维度表不变。AST去除这两个提示常量后与基点`7f0cdfd35c952a6fbe3a6693784a122114b2d597`完整相同，schema、解析、业务存储、归属及采纳代码零差异；没有新增typed字段、DDL、产品能力或联系人范围。

Conda `NotAlone` 下、`NOTALONE_DISABLE_DOTENV=1`／禁字节码／socket与DNS拒绝守卫，最小相关8模块实际 **111/111**（unittest2.360秒，外层3.690785417秒）通过：E/V适配器、原转述提示契约、Flow、语用、采纳、维度与ECNU受控SDK integration。只验证绑定、结构、原安全去向和工具行为，不证明新模型语义修复；没有新增镜像提示文字的“准确率测试”。两产品文件与新仓库外driver的mypy **3文件通过**，结果另存原日志；新真实HTTP0、App／桌面／业务库0，当前本目标真实计数24均闭账。

关闭后JSON保存的窄修只在新的仓库外 `candidate21.py` 副本，原`baseline300.py`与`probe_run.py`冻结字节保留。使用记录器原严格`_json_value`规范化UUID／datetime，不使用任意对象`default=str`。新25项Mock守卫第一次结果含UUID真实red及第二子例的夹具残留FileExistsError，保留不作产品红；清理各子例隔离后实际red2（25方法、UUID/date/未知对象3错误、0.805秒，unit exit1），窄修后 **25/25**（0.916秒，unit exit0）。初次外层最后chmod导致shell0不冒称unit成功，red2/green通过独立status文件记录真实unit退出码。未知对象仍安全拒绝且无半个JSON文件；真实发送前345秒、固定wall与审核限时、原run不可复开／第四基线禁止／既有闭账余额不复用等守卫保持。所有Mock预算只在独立临时home中，并在退出时清理；不产生真实新预算。

证据根目录 `/private/tmp/notalone-memory-goal-20261013-ac04d687/`（0700／0600）：`candidate21-prompt-projection.json`、`candidate21-product-minimal-tests.txt`与`candidate21-product-minimal-tests-status.json`、`candidate21-selftest-{red,red2,green}.txt`与red2/green status JSON、`candidate21-mypy-first.txt`；原5窗序列化诊断和语义审核未覆盖。新guard Mock夹具只装配三份已有公开判据，真实60项源码／提交字节冻结仍须另做，不借25绿代签。mac独立Standards与ocr独立Spec核本片精确三文件，各为0未解决项；仓库外driver另获两轴准备预审0，但不代签尚未生成的amend／bundle。此为提交前验证快照，提示效果仍未实测，默认维度表未启用；下一步是本地独立提交和新候选完整运行冻结。新amend-v4只允许独立候选准备：完整21窗保持，只有原前5可paired，原后16未知；专属配额54分为唯一实际注册42与另12永久退役／不注册／不挪用。总480、六个旧run24闭账与后续280／9未启不变，新供应商调用须Root最后冻结核验后唯一授权。
