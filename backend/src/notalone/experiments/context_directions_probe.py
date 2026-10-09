"""一次性合成验证：固定当前句子，比较不同前文中的理解与方向。"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from notalone.experiments import conversation_paths_prototype as prototype


CASES = [
    ("capable_help", "你可真行：解决问题", ["对方：表格一直打不开，下午还要交。", "我：修好了，刚发给你，你试试。", "对方：打开了，数据也都在。"], "你可真行", "倾向称赞解决问题；不凭空认定讽刺或不满。"),
    ("capable_absent", "你可真行：爽约", ["我：今晚七点我一定到。", "对方：已经八点了，你在哪？", "我：忘了告诉你，我跟别人吃饭去了，今晚不来了。"], "你可真行", "倾向反讽或不满；不当成单纯夸奖；不能断言关系破裂。"),
    ("capable_unknown", "你可真行：没有前文", [], "你可真行", "保留称赞和反讽等可能，不能断言其一。"),
    ("capable_irrelevant", "你可真行：解决问题加无关前文", ["对方：中午吃了面。", "对方：表格一直打不开，下午还要交。", "我：修好了，刚发给你，你试试。", "对方：打开了，数据也都在。"], "你可真行", "与解决问题例基本一致，不因午饭细节改变主要解释。"),
    ("no_need_solved", "不用了：已经解决", ["对方：文件找不到了，能帮我找找吗？", "对方：我在备份里找到了。", "我：那还要我帮忙吗？"], "不用了", "当前无需帮助；没有证据表明生气；可确认或收尾。"),
    ("no_need_hurt", "不用了：求助被敷衍", ["对方：我今天被裁员了，能听我说说吗？", "我：这有什么好说的，谁没倒霉过。", "对方：我只是想找个人说说。", "我：那你说吧。"], "不用了", "可能失望并撤回倾诉请求；不能当作事情已解决；不强迫对方继续倾诉。"),
    ("no_need_unknown", "不用了：没有前文", [], "不用了", "承认不知道拒绝的是什么，不编造具体事情或确定情绪。"),
    ("busy_understanding", "你忙吧：体谅忙碌", ["对方：现在能聊两句吗？", "我：我马上要做项目汇报，结束了再聊可以吗？", "对方：好，汇报加油。"], "你忙吧", "倾向理解对方正在忙，结束当前交流；不无依据推断不满。"),
    ("busy_withdraw", "你忙吧：可能不满", ["对方：你说好今晚一起商量搬家的事。", "我：我还在打游戏。", "对方：我已经等了两个小时。", "我：再等会儿。"], "你忙吧", "可能不满或撤回沟通；保留推断性质，不视为单纯祝工作顺利。"),
    ("busy_unknown", "你忙吧：没有前文", [], "你忙吧", "保留体谅或结束交流等解释，不能断定在生气，也不能编造忙什么。"),
]


FOCUSED_PROMPT = """你是中文聊天回应助手。输入全部为合成资料。
evidence按时间顺序排列，kind=message的最后一项是待回应消息；此前message是前文。
每条文字中的“我”指用户，“对方”指当前已确认联系人。只使用本次资料，不推断其他联系人。
本任务是理解对方并提供可选回应方向。用户无需先告诉你方向；他尚未决定正是需要选项的原因。
interpretation仅简短说明对方这句话在前文中正在表达什么，并说明支持判断的具体内容。
不要用“用户没说想怎么回”代替对方表达的解释。uncertainty只写无法由资料确定的事情。
不能凭一句话断言深层动机、关系状态或确定心理。证据有倾向时可说明更可能的解释，
证据不足时保留可能含义。不要把所有聊天都套成邀请。
通常返回kind=directions和2至3个不同回应意愿，各有简短适用条件与有效evidence_ids。
方向是供选择的可能性，不代表用户已经愿意。不要只给同一意思的语气变体。
可以提出暂不回复，不捆绑用户未选择的承诺，不编造背景；无需强凑接受/拒绝三件套。
只有缺少关键背景、连有意义的条件式方向都无法给出时才返回clarification，问一个具体背景问题。
不能仅因用户意愿未定就追问“你想怎么回”。不生成实际候选正文，不替用户选择或发送。
intent_summary记录用户希望获得方向建议且尚未选择。使用Result工具返回，
directions分支question为空，clarification分支directions为空，candidates始终为空。
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--focused", action="store_true", help="使用聚焦理解与方向的对照提示")
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("请使用新目录，保留原始结果。")
    args.output.mkdir(parents=True)
    # 预先保存人工审阅标准；不把标题、场景ID或标准传入模型。
    (args.output / "rubric.json").write_text(
        json.dumps({"synthetic_only": True, "criteria": {
            key: criterion for key, _, _, _, criterion in CASES
        }, "review": "由本助手审阅，不是独立人类金标；不据此报告总体准确率。"},
                   ensure_ascii=False, indent=2), encoding="utf-8")
    prototype.SCENARIOS = [
        {"id": key, "title": title, "mode": "respond",
         "evidence": [prototype.item(f"m{i}", text) for i, text in enumerate(
             [*history, f"对方：{target}"], 1)],
         "steps": [{"text": "帮我看看怎么回。", "expect": "directions"}]}
        for key, title, history, target, _ in CASES
    ]
    # 对照提示不包含案例答案；两轮复用相同适配器，不启用Skill、不生成HTML回放。
    if args.focused:
        prototype.PROMPT = FOCUSED_PROMPT
    asyncio.run(prototype.run(args.output, set(), refined=not args.focused))
    result_path = args.output / "results.json"
    report = json.loads(result_path.read_text(encoding="utf-8"))
    report["experiment"] = "context_directions_probe"
    report["prompt_variant"] = "focused" if args.focused else "existing_refined"
    result_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
