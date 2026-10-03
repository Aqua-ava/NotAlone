# 知识漏提与转述漏核的本机准备（2026-10-03）

状态：按用户“好的继续”完成本机诊断、私有可行性和具体方案准备，未启动新模型试验，未修改正式程序。14项独立本机控制及相关类型／AST通过；原捕获安全断言仍失败，没有语义修复成功结论。

## 旧问题的复现和归因

[上一轮匿名对照](memory-atomic-coverage-pilot-result-20261003.md)仍是联合完整6/8、知识0/2且失败关闭，原2条评测坏auto。当前原V公开请求实际包含第三人正文和E的错误assertion/asserted标签，V仍返回supported且issues为空；原Flow及采纳门据合法结构得到auto。没有发现字段／索引丢失、降级标记丢失或门槛绕过；这是模型已有语义规则执行失误，不是已定位的确定性程序Bug。

同一首捕获已在产品原E／V Runtime、ExtractionFlow及can_auto_adopt接缝重放。`python -m unittest captured_original_feedback_v1 -v`在Conda NotAlone下exit 1：朋友转述安全断言失败，两条均auto；热茶正控制通过。2项不同方法，只有捕获回放，0新模型调用。首失败收据SHA为`e8c3effc06030e9809b4b7fbedb066aeda8e3629997f5bff934c5d40c54b9a66`，原捕获和原断言不改。

当前原E／联合请求没有明确“谁不知道什么必须保留”的专门句，但历史#3／#4／#12及[text单叶](memory-knowledge-text-isolation-plan-20261003.md)已承担同一知识边界职责。旧text单叶匿名曾4/4，开发仍失败；旧匿名请求与本轮原E的system、user messages及bound_kwargs完全相同，bound_tools唯一差异就是text.description。恢复该字符串是重复已测配置；不能把“当前缺专门句”说成“以前没试过”。本轮没有重抄后开API，也没有承诺用一条提示解决漏提。

旧[逐字段V](memory-core-claim-retention-20261002.md)已有九项正文／主体／语用／时间／来源判断，坏auto曾2到3，确定负例supported曾3到6。因此单纯重复字段检查也不是新方法。

## 本机要回答的问题

使用现有`verify(window, facts)`、Flow与采纳接缝，私有Adapter隐藏候选三个语用标签，让一次V从来源独立返回对应主张的三个标签；程序比较后只降不升，不改14字段。具体新wire、固定候选和采用门见[8次有限提案](memory-source-pragmatics-pilot-proposal-20261003.md)。模型仍看到候选正文／类别，来源标签仍可能误判；同错标签的反例必须保留。

可证伪假设为：隐藏E标签、来源独立标注与确定性比较的联合方案能否减少错误放行；若新来源标签仍与E一致误判，则该方法不能阻止该错放行；新来源判定与确定性分流的连接是否按约定降级。前两项必须真实新V返回才能验证，且不能单独归因于隐藏。本机只回答信息是否隐藏、比较／降级是否正确和正例是否仍有可表达路径。

原捕获安全反馈保持红。人工正确来源标签或脚本positive control的green不能称真实V已修好；全部机械测试、SDK仅绑定和捕获重放不能替代语义评分。

一手研究提供的是输入隔离的参考：CoVe让核验回答与草稿答案分离，但仍会出错。本轮只隐藏三个标签，继续看候选正文、subject和类别，没有核验计划、逐题调用或模型重写；只是局部借鉴，不能套用论文收益到中文关系记忆。[论文正文§3与局限](https://aclanthology.org/2024.findings-acl.212.pdf)、[本机研究笔记](../research/source-pragmatics-independent-verification-20261003.md)。

## 实际本机结果

`python measured_controls_v1.py`实际运行14项不同unittest方法，全绿；Scripted／Replay E=26、V=26，均是已捕获返回或人工边界控制，真实新模型调用0。检查覆盖完整请求隐藏、按候选来源主张比较、supported不一致只降级、原uncertain／unsupported不升级、完整正例保护、索引／证据／枚举／额外字段／非法tool整批失败、空／超额不调用，以及公开返回先捕获后编译。

人工正确来源标签配旧错误E标签，可在原Flow得到pending／pending／auto；原本正确report与喝茶assertion仍按原门保留。人工来源与E同错时仍auto的限制反例通过，不能称模型一致就是正确。14方法不是14条新语义样本；原捕获的两方法仍分别为安全red与喝茶green。

审查发现私有初版的嵌套隐藏内容会被deepcopy读取、缩写system省掉部分旧详细边界，均先保留失败后修正。现复用旧纯`public_response`，先筛key／type再读取值，observer和parser均只读公开投影；nested poison覆盖content／metadata／tool_calls。system以现行原V为基底，仅5段锁定局部替换加来源返回说明，保留人物否定、期间、阶段、shared、动作执行者与候选来源证据要求。没有把新语义判断伪装成确定性规则。

5个私有文件`python -m mypy …`与AST通过，8个纵切首失败和源码快照、类型注解首失败均保留。Worker最终收据SHA为`1a8648b81a59a73977ed190eec7887591cad34c0a28e57e90342848951a404a3`，Runtime SHA为`de8bc97b5ad0fce37ad63708cb2bfd0866fb49b30d4aac1a68686bfc83cc46c3`，显式旧纯投影依赖SHA为`2c1ca3680632ede8e79dd096c0c7d10cfb79efa6aae05a27ca4b214cadf91370`。完整路径、命令及快照绑定见私有`implementation-v1/local-preparation-final-receipt-v1.json`。

root另用合成凭据构造一次SDK并仅绑定原V和新V两种Tool，DNS／socket均禁止；2种绑定通过，invoke和网络尝试均0。这只证明安装版本接受schema和tool_choice，不能证明ECNU实际可用或模型语义改善。实际版本为LangChain1.3.15、core1.5.5、langchain-openai1.5.1、langchain-deepseek1.1.0、OpenAI3.3.1、httpx0.28.1；未升级依赖。

root仅绑定脚本另有1文件mypy／AST通过，首次私有查找路径错误保留后修正环境路径。root核对101个字节指纹与110项私有权限，无违反，收据SHA为`676807ff7bcfc838d45aadcfffdcfb78d233926f4c5fca7c22cf4441184ecf6f`。首次把历史类型失败时的工作源码SHA与当前源码强行比较的审计失败已保留；核对历史收据／日志不变与最终源码／最终类型通过分别成立，未改首失败文件。旧公开捕获、raw／final独审SHA和已关闭8/8预算保持。

## 范围和读取披露

材料在仓库外`~/.notalone/audits/memory-source-pragmatics-preparation-20261003/`，目录0700、文件0600；实现、捕获和参考不提交Git。研究笔记沿既有`research/`保存，不强制加入被忽略文件。新联网预算当前0，真实凭据SDK构造／ECNU凭据读取／业务记忆／水位／默认／产品源码写入0，合成凭据SDK构造1次；旧预算关闭。

两位只读explorer首次过宽rg分别意外显示旧仓库`replica_cases.py`与`fidelity_holdout_cases.py`少量合成留出行；已立即限定文件、不继续读、不回传或用于方案。真实私聊和私有留出值未读，但不能写“所有Agent留出读取0”，该暴露部分不能再对对应Agent称未揭晓。当前提案只用原四条已揭晓匿名资料和已见raw；未来留出需独立冻结，不能复用污染部分冒充盲验。

整体记忆语义和覆盖目标仍未完成；原实际必需6/12、可选2/6保持。新试验只准备、待具体决定，不能把当前同意继续准备解释为旧试验重启或正式采用。
