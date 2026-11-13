# 必要依赖与独立保存决策的交叉教学

## 证据与假设

- 双max场bcbb的P02实际输入包含两个target，事件dependency枚举包含声明0:0；模型仍输出null，V supported/proof=null，原门安全停止。
- `grounded_adapter.py:53`允许另一target作依赖，v2正例仅展示context声明（原行146–150）。
- `grounded.py:234`的编译路径不排除kind=not_memory的依赖；独立材料离线对照确认只有显式选择才增加来源。
- 待检验假设是模型混淆“本身不保存”和“不能供引用”。不是已证根因，也不把V漏检归因于缺少规则。

## 最小变更

- 新不可变v3教学，仅独立bounded thinking配置选择；旧v2及default/stage/core/reference保持。
- 用独立记录册/青签材料示范target声明自身not_memory、后行仍以其为必要dependency；配无关not_memory前文的null对照。
- 四交叉条件为前文context/target与必要/无关；不使用Gold措辞、人物、答案或置信度，不扩展证明语法。
- schema、compiler、真实输入角色、V提示、来源守卫和原15/Gold不变；不自动补来源。
- 请求仍合同5、Pro E/V max/omitted/8192；教学身份与摘要必须精确绑定，旧预算不复开。

## 验证与执行门

- 先离线红→绿验证新profile、旧字节、交叉材料和显式选择才保留来源；漏选不能被程序修复。
- 运行相关合同/SDK/owned路径验证、改动模块mypy与独立Standards/Spec；工程通过不能签模型效果。
- 真实后继须另行冻结新源码和run/cap30、零重试，仍按原15逐窗RAW→FULL硬停；本计划本身不启动请求。
- 原bcbb结果保留，质量门、生命周期与生产空放行表不变。

## 实际离线验收

- 66项合同/登记/实际SDK/owned/fixture测试通过（36.077秒）；36项旧配置/任务恢复/V字节兼容测试通过（2.098秒），8源码mypy通过。
- 四交叉测试覆盖context/target、必要/无关；not_memory仅作为原独立判断的前提，漏选不补源。
- Phased新增可选provider身份：旧默认保持，v3必须有精确thinking身份；任务接缝只保留显式注入v3，其余仍v2，不新增持久字段。
- 独立Standards/Spec各0实质问题，git diff --check通过。本轮真实模型调用0，尚无v3质量信用。
