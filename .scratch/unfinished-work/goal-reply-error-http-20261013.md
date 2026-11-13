# 最终App暴露的会话生成错误映射（2026-10-13）

对应[Mac20原票](../mac-desktop-app/issues/20-mac-app-delivery.md)的必要集成修复，原[同包组合记录](goal-final-app-combination-20261013.md)保留前两场。新增功能冻结，真实微信／OCR／供应商模型不进入本片。

## 实证与最小产品修复

Root在同一签名B包的第三组剩余61项实际运行4通过／1失败／5跳过／51未运行，22.1秒（runner22.923秒）／exit1／5次App启动。失败在原空候选断言：实际HTTP500为`internal_error`，要求`reply_generation_failed`。目录`desktop/artifacts/goal-final-last-group-20261013-b/`保留计划、固定清单、日志及失败上下文。

当前App通过助手会话的`/replies`入口生成。空结果仍被`ReplyGenerator`硬拒，`AssistantSessionService`保存failed后原样抛`ReplyError`；该HTTP路由漏映射，落到总分发的通用500。旧独立`/api/reply/generate`已有对应映射，旧API通过不能代签当前路由。只在会话handler补`ReplyBudgetError`→502／`reply_budget_exceeded`及余下`ReplyError`→500／`reply_generation_failed`；原持久化503、供应商上下文409、输入预算及超时504优先，未知异常仍通用`internal_error`。异常正文不回显，空候选门槛、生成或采纳权限不改，不迁移数据。

## 实际HTTP回归与保留失败

新增真实HTTP／PG测试以正式迁移和生产生成器运行，只有模型边界返回公开合成输出。实际红灯1项、0.567秒：精确复现`internal_error`。修复后最小2/2、1.370秒通过：空候选保持failed且无reply，同键显式恢复复用原turn，完成重放无新增模型；七异常类别核精确安全错误码，未知RuntimeError保留原兜底。另34项原会话／独立回复方法已在同一产品修复源码的首轮通过，不能将分批结果写成某一轮36/36。

首轮准备的库名64字符被PG截断，0项测试运行；按短名称及实际`current_database()`核同后才取得产品红灯。首36方法中两个新增方法失败：实例slots不允许patch方法、脚本按累计调用序号消费而非队列；只改测试为类方法patch及append下一脚本，随后最小2项通过。上述准备和测试错误全部保留，不冒称产品红灯或删除难例。私有`desktop/artifacts/goal-reply-error-http-20261013-b/`分存初准备、`actual-red/`、首`green/`失败及`green-final/`；每次Root精确自建库均已核gone。

完整`server/app.py` mypy返回78个错误，未报clean；固定`15876c41`与现源码以同一`mypy --no-incremental --follow-imports=silent -c`命令对照各82个相同诊断，新增0。该对照模块方式不同于完整文件命令，因此78与82不能混用；旧类型债不在这几行错误映射修复中扩大。两轴源码Standards硬／启发式0、Spec遗漏／越界／错误0，评审只读。

## App回归的另一个失败

同B最小场02:52:14.460–03:02:14.460、max1/actual1，实际10.0秒（runner11.136秒）／exit1：普通失败步骤已显示会话拒绝，空候选步骤未运行。另加安全状态诊断后，02:59:40.116–03:07:40.116、max1/actual1又复现；只见生成响应200→504→200，下一步未进入第4次生成，公开状态为failed／rejected、当前联系人仍匹配合成范围。因此不能将泛绑定文案判定为绑定真的失效，或认证该HTTP修复已在App完成。

诊断场在断言前保留自有App／fixture PID、目录及精确库名；Root核两个PID、两个目录、该精确库均gone及共享租约absent。此前另外有1个无连接测试库缺少归属收据，仍保留，不从命名空间推定归属或删除。新增白名单诊断不保存请求正文、候选或身份；原所有断言保留。后续独立定位已完成回执与版本读取之间的作业竞态，当前片不代签该后续修复、最终包、权限、OCR、真实渠道或模型质量。
