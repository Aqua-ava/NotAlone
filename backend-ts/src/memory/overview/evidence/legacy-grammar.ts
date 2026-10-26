// 固定旧来源证明v1/v2声明合同；从既有source_proof导出，不在运行时调用Python。
export const legacyGrammar = {
  "grammar": {
    "arrival_source": "(?P<author>我)(?P<time>刚刚|刚)到家",
    "arrival_candidate": "(?P<author>用户|联系人)(?P<time>刚刚|刚)到家",
    "lend_source": "(?P<action>(?P<related>我姐|我哥)(?P<time>昨天|前天)?(?P<negative>没有|没)?把(?P<pronoun>她|他)的(?P<object>车|书|雨伞)借给(?P<author>我)(?P<completion>了)?)(?:。(?P<identity>这里的“(?P<identity_pronoun>她|他)”指(?P<identity_role>我姐|我哥|我同事)))?",
    "lend_candidate": "(?P<action>(?P<agent>(?:用户|联系人)(?:的(?:姐姐|哥哥|同事))?)(?P<time>昨天|前天)?(?P<negative>没有)?把(?P<owner>自己|(?:用户|联系人)(?:的(?:姐姐|哥哥|同事))?)的(?P<object>车|书|雨伞)借给(?P<completion>了)?(?P<recipient>(?:用户|联系人)(?:的(?:姐姐|哥哥|同事))?))",
    "request_source": "(?P<action>(?P<related>我姐|我哥|我同事)让(?P<inner>(?P<author>我)(?P<time>(?:周末|明天|后天))帮(?P<pronoun>她|他)顶个班))(?:。(?P<identity>这里的“(?P<identity_pronoun>她|他)”指(?P<identity_role>我姐|我哥|我同事)))?",
    "quoted_request_h": "(?P<requester>(?:用户|联系人)(?:的(?:姐姐|哥哥|同事))?)已提出请托，内容是希望(?P<inner>(?P<actor>(?:用户|联系人)(?:的(?:姐姐|哥哥|同事))?)(?P<time>(?:周末|明天|后天))?替(?P<beneficiary>(?:(?:用户|联系人)(?:的(?:姐姐|哥哥|同事))?|该(?:姐姐|哥哥|同事)))顶班)，未说明接受",
    "received_request_h": "(?P<recipient>(?:用户|联系人)(?:的(?:姐姐|哥哥|同事))?)(?P<outer_time>(?:周末|明天|后天))?已收到(?P<requester>(?:用户|联系人)(?:的(?:姐姐|哥哥|同事))?)请托；所请内容为(?P<inner>(?P<actor>(?:用户|联系人)(?:的(?:姐姐|哥哥|同事))?)(?P<time>(?:周末|明天|后天))?替(?P<beneficiary>(?:(?:用户|联系人)(?:的(?:姐姐|哥哥|同事))?|该(?:姐姐|哥哥|同事)))顶班)，未说明接受",
    "commitment_candidate": "(?P<actor>(?:用户|联系人)(?:的(?:姐姐|哥哥|同事))?)(?P<commitment>已答应|答应|有义务|已经|已)(?P<time>(?:周末|明天|后天))?替(?P<beneficiary>(?:(?:用户|联系人)(?:的(?:姐姐|哥哥|同事))?|该(?:姐姐|哥哥|同事)))顶班(?:了)?",
    "execution_candidate": "(?P<actor>(?:用户|联系人)(?:的(?:姐姐|哥哥|同事))?)(?P<commitment>已经|已)顶班(?:了)?",
    "plan_source": "如果(?P<condition>天晴)，(?P<action>(?P<author>我)(?P<phase>计划)(?P<time>明天|后天)(?P<only>只)?跑(?P<approx>约)?(?P<distance>(?P<number>(?:[1-9][0-9]{0,5}(?:\\.[0-9]{1,3})?))(?P<unit>(?:公里|米))))",
    "plan_candidate": "(?:如果(?P<condition>天晴)，)?(?P<action>(?P<author>(?:用户|联系人)(?:的(?:姐姐|哥哥|同事))?)(?P<phase>计划|已经|已|肯定)?(?P<time>明天|后天)?(?P<only>只)?跑(?P<approx>约)?(?P<distance>(?P<number>(?:[1-9][0-9]{0,5}(?:\\.[0-9]{1,3})?))?(?P<unit>(?:公里|米))?)(?P<completion>了)?)"
  },
  "rulesHash": "b3e74a14c5c7d1d9589c7f8d53b107a67937432c9f218f2b83d7c5b401fe76c6",
  "quoteRulesHash": "084abeae1a1f67e363ae41a1d8a6d4a5d0a88d7f3b6017a994bf2a9003d1a276",
  "capabilities": [
    "author_binding",
    "arrival_event_preservation",
    "author_self_reference",
    "direct_attribution",
    "recency_preservation"
  ]
};
