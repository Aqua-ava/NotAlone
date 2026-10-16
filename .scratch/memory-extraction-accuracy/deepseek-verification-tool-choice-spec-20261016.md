# 官方DeepSeek思考模式的来源核验工具绑定

Triage: ready-for-agent

本片属于[原07](issues/07-reference-resolution.md)正式链路的兼容修复。精确SDK Mock已发现：正式`build_extraction_components`显式启用thinking，E请求省略tool_choice，V却强制具名`SourceVerificationOutput`。安装的langchain-deepseek 1.1.0／langchain-openai 1.5.1／openai 3.3.1未自动修正。Context7不可用后核[官方Chat Completions文档](https://api-docs.deepseek.com/api/create-chat-completion/)及[Thinking说明](https://api-docs.deepseek.com/guides/thinking_mode/)：思考模式不支持required或具名工具选择，省略effort默认high。这里是实际请求与文档不兼容的证据，尚未测真实端点，不能记录成已发生的HTTP400。

## 最小行为

正式来源核验在已知官方DeepSeek Flash且配置为思考模式时，保留原唯一工具及schema，省略tool_choice。不关闭thinking、不改effort、模型、提示、schema、核验模式或重试设置；不增加第二次模型调用或不返回工具时的修复调用。显式关闭思考的官方模型、非官方端点、其他模型和既有fake adapter保持原具名绑定。

供应商配置识别复用已有官方模型／端点判断，在适配层集中解释实际model的`extra_body`及`reasoning_effort`。只读取配置，不探测端点。显式enabled或low/high/max及官方兼容别名minimal/medium/xhigh/ultra为启用，原参数值不作归一化；未指定且无禁用时沿官方启用默认。明确disabled／none且无矛盾启用项时保持关闭行为。矛盾配置不猜优先级，保守省略tool_choice以避免强制工具冲突，不将其归为已关闭思考，也不静默更改用户配置。无效配置不通过本片修复或伪装成功。

V仍严格要求唯一、指定名称的合法tool call及精确字段；没有工具、错名、多工具、额外proof、证据或覆盖不合法照旧失败。所有legacy／nullable版本及程序只降不升规则保持；V不因省略强制选项接受自由文本或把unknown升级。E的绑定和整个编译阶段不改。

优先保持小的纯配置判断与现有V调用接缝，不新建模型wrapper、runner、通用供应商注册表或额外公开配置开关。完整trace和原始请求记录应反映实际发送策略，不能仍声称已强制具名。运行中的核心冻结树与场次保持，修复只在独立ref树准备，后续重新冻结。

## 验证与完成条件

先在实际SDK＋正式装配的精确Mock捕获当前enabled＋forced的红灯，再最小修复。禁真实socket，假key及PG构造哨兵，明确Conda和实际模块路径。核E请求不变、V思考及effort不变且只省略tool_choice、唯一工具/schema原样、同次两请求正常解析；所有strict失败不增加请求。

配置矩阵包括enabled、三档启用effort、官方默认、disabled、none、冲突项、非官方端点及非目标模型；明确关闭及其他模型的原绑定保持。覆盖legacy-v4与两个nullable合同的合法响应和原非法响应；程序降级及Flow/adoption不变。最小相关、完整提取与记忆相关、类型及独立Standards／Spec审查通过后本地提交；Mock及官方文档不能代替后续真实端点、质量或运行依据验收。

本片不创建真实预算、读取凭据或业务库、执行迁移、改Gold／旧封存、放行维度、操作桌面或远端Git。新公开合成实际评测仍须使用新封闭身份、原始记录、有界调用及RAW→FULL审核，不挪用核心56次。
