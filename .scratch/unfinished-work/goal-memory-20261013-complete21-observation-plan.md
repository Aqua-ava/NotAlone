# 完整21窗当前候选观察预注册（2026-10-13）

本文件只登记一次新的有限观察，当前HTTP0、预算注册0、App0。它承接[新的有限42次分配](goal-memory-20261013-complete21-budget-amendment.md)，不是此前提示的完整基线、因果A/B、第四次基线或质量通过。原21窗、28必需＋1可选、A14唯一用户纳入决定、Gold、旧sealed和旧成绩保持；默认生产放行表仍为空。

## 固定范围与配额

| 项目 | 冻结值 |
| --- | --- |
| 新run | `8d0460a1-56c6-4226-842b-2c383929c539`，独立cap42 |
| 样本 | 原A01–A19、B01–B02全部21窗，原序和全部难例保留 |
| 输入 | 仅已有公开合成材料；不读取或上传真实聊天 |
| 源码 | `c8d0a5eda8de5f5bb28d4a34a7fe6134cf29f832`，60份工作字节与提交blob冻结 |
| Gold | [原完整参考](memory-gold-reference-20261012.json)，规范SHA `5fb8d53b90a1a96c5987ac7b825bb233cc3e9f196f976e4851c40b0243b77b32` |
| 模型 | 根.env既有ECNU loader，请求`ecnu-max`；服务响应alias另列，不据alias切换供应商 |
| 请求限制 | SDK和两个HTTP transport均300秒，retries0；每次真实HTTP先持久预约，最多42 |
| 时间 | 台北2026-10-13 07:30–11:30，绝对截止固定，不滚动延长 |
| 最后起发 | 台北10:59:15，预约前保留1845秒：两请求读限、两审核阶段及45秒收尾规划余量 |
| 审核 | raw、full各600秒；完成入口冻结和case身份核验后、写view之前起算，含compact/view写入耗时；读前和读后复核 |

300秒是请求读限，不是总墙钟保证。绝对SIGALRM覆盖真实API、batch、审核和API收尾，并在本机入口finally恢复原handler/timer；已有alarm拒绝覆盖。11:30的绝对观察截止保持，即使请求、审核或清理耗时超出规划余量，也不得补发或滚动期限。

之前九个stage全部closed：总cap188、实际43（39个200，4次旧ReadTimeout远端未知）、关闭未用145。永久退役未注册12不调用；全140专属280未启用、不挪用。本新42为追加分配，总522＝188＋12＋280＋42。新stage闭账后未用额度同样永久关闭；不自动追加第二场或后继全量。

## 不可变计划与实际接缝

私有证据根目录为 `/private/tmp/notalone-memory-goal-20261013-ac04d687/`，0700；下列计划、工具和证据文件均0600。唯一prepare实际exit0，没有模型、凭据读取或真实注册；离线guard禁止网络和.env读取，冻结验证通过。该guard保留一次被审计拒绝的`socket.bind`：实际栈为已安装urllib3导入时`_has_ipv6("::1")`的本机IPv6能力探测；未连接网络或发送HTTP，见`complete21-offline-guard-denied-event.json`，不把审计attempts改成空。

- `complete21_observation.py`：SHA `72c91589b6cbc8ce462564dad7062e935dd239d5588b75f9ddb79f601e6aa0dd`。
- `complete21_observation_selftest.py`：SHA `17e6dfd95c00c1bbaa24bd2ca0d9f856241175c3707fb797147ac61e077b52c6`。
- `manual_complete21_review.py`：SHA `d1b530596b6ac8ebc0356324fb5d6e63c652ce64b74d99e2a1e7d202979a8e96`。仅复用旧显式判断装配，替换精确输出前缀和Agent说明；无默认通过，使用O_EXCL、0600、fsync，不发送请求。
- `complete21-observation-plan-v1.json`：bundle规范SHA `ae6b272d783e29152efe3fc8bcda4c113461be580d6ff2114b0d0c12b8cacb3d`；同时冻结21输入、60源、8安装版本、原Gold/标注、三个复用工具、commons和九份closed收据。
- `goal-budget-amendment-v7.json`：规范SHA `a169ca075abf987765da6270e184fd7bd590a617942894cf50f9004225a709a3`，不可变追加42，保留原index、v6及所有旧计划，不借已关闭余额。
- `complete21-observation-review-metadata-v1.json`：当前字节/提交blob、文件权限、源摘要、计划、离线guard和注册缺席证据。

真实入口仍为现有`run_ecnu_evaluation`默认21/42分支，审查对象严格为`PhasedEvaluationAudit`，不使用自由cases、validator、无计数CLI或新的产品接口。先创建有限预算，batch领取后才调用既有最小.env loader；所有SDK重试同样受真实HTTP计数约束。本stage retries0。source60从prepare起冻结，Root最后核验并授权唯一executor前，不执行run、不注册预算。

## 显式审核与停止

Agent先看完整E-only及可核验compact视图，逐候选判断14个E字段、来源、语义、纳入、分类和安全，再明确填写JSON答复并持久封存；之后才能看V/full，逐项判断4个V字段、引用支持、final、去重、时间处理和lineage，保留完整原view及两阶段clock。本轮是知情的Agent审核，不宣称人类亲审或盲审。

忠实保留未知且界限清楚的输出可以记safe；将未知人物确定化、捏造来源或不适合确定采纳的输出应据风险记ambiguous/unsafe。safe-only scorer、原Gold和所有已封存判断不变，不能用本前瞻说明重标旧A03或救旧full0。风险、非空备选与错误destination按实际auto映射接受安全检查；生产空放行表不因此改变。

一般语义错误如实记`general_error`并继续固定剩余窗；`bad_auto`、未决安全、技术unknown、契约/来源漂移、缺失或迟到审核、存储/收据/cleanup失败、绝对截止均停批并闭账，保留unknown/unrun。合法空E不补一次V来耗额度。未知计数记null，不冒记0；main只在全部21完整、无停止/失败/unknown/unrun、闭账收据可核且无记录/清理错误时exit0。质量字段始终false，exit0也不代表原语义质量门通过。

预定产物为`complete21-observation/`下入口PID、逐case实际记录、completion、严格JSON的run-result和run-summary，以及`complete21-observation-reviews/`下完整view、compact、clock和显式review。终态需核持久SQLite真实计数、响应/重复/未运行、closed、客户端和记录收口、精确入口进程与in-flight锁、源摘要、资源清理。保留持久记录和锁文件，仅核锁是否仍被持有。

## 准备验证与未运行边界

最终`complete21-observation-selftest-final-freeze.json`：25/25、0错误、0失败、0.205512208秒；外层0.687307958秒。覆盖1845秒起发门、closed不能复开、raw封存后揭full、600秒写入和最后sleep边界、错位置/未知case/重复view/权限、strict UUID/date JSON、未知计数null、收据/清理失败拒签、绝对timer恢复及522配额。不是实际等待600秒，不认证模型语义。

`complete21-observation-mypy-final-freeze.status.json`：1源通过，0.830467083秒。两份验证的runner、selftest和manual SHA与最终冻结相同。准备首轮24控有一项复制的旧345秒测试预期未更新到1845，保留first日志，属夹具错误；首次mypy缺MYPYPATH造成导入诊断，保留first日志，补正确源码路径后通过。未把这些工具失败宣称模型或产品语义红。

helper反替换说明和前缀后与旧版本逐字相同，见`complete21-helper-adaptation-proof.json`。旧阶段关闭、实际43和原分母未改变。本文件不替代原07、核心01、维度03各自未满足验收，也不认证全140参考已完成。

Root于台北07:21:47独立只读核验实际exit0：60当前字节与c8d提交blob、6私有工具摘要和0600权限、8安装版本、全部21原输入和Gold规范摘要均一致；九个真实SQLite以mode=ro核得closed、cap188、实际43，新run注册及输出目录仍不存在。随后在拒绝网络和.env读取的审计守卫内执行现有guard通过，同样保留urllib3本机IPv6导入探测的1次拒绝bind，connect和凭据读取均0。证据`root-complete21-final-readonly-preflight.json` SHA `95442c7533873310d0bb3a302ebb89b6e45a1379d634b14273d7aedc03356a40`。准备工具独立Spec已0；Standards源码无实质问题，以上clock说明已精确对应实际入口。最终文档评审收据另存私有证据，首发须等文档双轴0、本地提交及Root唯一激活。此准备核验时尚未注册、读取密钥或发请求。
