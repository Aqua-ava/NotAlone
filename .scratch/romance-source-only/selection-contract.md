# 原文依据重做：最高优先级制作合同
用户纠正：所有东西必须来自原来的五个Skill；不允许自编/合成案例，不允许凭一般常识补方法、不凑每包两例。
以此合同替代上轮authoring.md的一切造例/字数/案例数量要求。原来92个目录仅是用户确认的任务索引，不是92项已被源文逐条证明。
原文件已经取回：.scratch/romance-source-only/upstream/<D/E/G/C/T>/<原路径>；索引upstream-index.json含仓库、固定commit、原Git blob SHA。
你只做“源文连续行段选择清单”，不要撰写、翻译、改写任何方法/案例，也不要修改成品包。
读取reply-skills/romance/catalog.json中指定范围。每项产出：
{id, support:"direct"|"shared_method"|"unsupported", methods:[{source,path,start_line,end_line}], examples:[{source,path,start_line,end_line,kind:"dialogue"|"phrase"|"template"|"scenario"}], notes:"必要的编辑说明"}。
source为D/E/G/C/T之一。D根README补查确认：84–86及165–167行声明MIT，62行允许复制技能目录并按需调整；虽无单独LICENSE文件，仍可依据原声明选段。原许可声明单独保存。不要把不同场景硬借来充数。
direct=原文确有对应问题或处理方法；shared_method=只能引用更通用的原文方法，必须说明源文未单列此场景；unsupported=没有找到相符方法，methods/examples为空并说明缺口。
每个method尽量15–50行，1–3个段；给完成当前细场景必需的步骤与判断，不用整章大段灌入无关信息。
每个example只选原文实际存在的示例：原话、作者模板、对话或场景可按实际类型标注。没有例子就examples=[]，不得从方法自己变造例子、不得从旧184合成案例取任何素材。
start/end为实际源文件1-based包含范围，保留原字句、原身份角色与上下文。若选片段不含背景，渲染时也不会增加背景。
避免章节里与本任务无关的系统角色、执行脚本/Tool/网络/数据库说明；例句内普通“发消息”可，但原文的“发送消息/发送回复”、URL、脚本执行会被现有包校验拒绝。
不改变校验器绕过问题。源段含URL/运行能力/明显逼迫拒绝等不适用内容时选更具体合适的连续片段，不得把无依据的新话写进来。
正文选择优先具体方法，原包有好坏对照就完整选。不要把原文缺案例理解成任务失败。
原文不一定真实发生，标记为“原作者示例”，不能宣称真实案例/实际效果。
语气与长短不新编；每项的用途由既有92标题索引表达，方法本体全部由主Agent从这些行段确定性抽取。
选择JSON写入.scratch/romance-source-only/selections/<001-031|032-062|063-092>.json。允许脚本辅助读取行号/生成JSON，选择必须人读过并核对相关性。
首次交付先完成全范围source selection，然后自己逐段检查行号/主题，给总结哪些没有原文例/哪些shared/unsupported。
主Agent负责全量字节追溯校验、确定性渲染、更新案例数量检查、安装和实际App验证、本地提交。
开发只用pnpm run dev复用已有实例，不打包不push。不要读取真实聊天/外部模型/安装目录；不要提交。其他Agent在平行选不同范围。
用户后续补充：Skill正文无需仓库、文件、行号标注，所有溯源放额外文档。主Agent将选择JSON写入包外SOURCES.md与provenance.json；正文/示例只保留方法内容，不放出处。此变更不影响你选择原文行段，也不放宽不得合成/新增方法的要求。

