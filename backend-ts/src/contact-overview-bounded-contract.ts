// 固定旧业务有限证明词法；只读复验沿用原规则摘要，不创建新证明。
export const boundedContract = {
  "GRAMMARS": {
    "arrival": "(?P<author>我)(?P<time>刚刚|刚)到(?P<destination>家)。?",
    "identity": "这里的“(?P<pronoun>她|他)”指(?P<role>我姐|我哥|我同事)。?",
    "roles": "这里提到(?P<first>我姐|我哥|我同事)和(?P<second>我姐|我哥|我同事)。",
    "lend": "(?P<agent>我姐|我哥)(?P<time>昨天|前天)?(?P<negative>没有|没)?把(?P<pronoun>她|他)的(?P<object>车|书|雨伞)借给(?P<author>我)(?P<completion>了)?。?",
    "question": "你(?:已经|已)?(?P<verb>到达|抵达|到)(?P<destination>家|公司|学校|机场|车站)了吗[？?]",
    "answer": "(?P<author>我)?(?:已经|已)?(?P<verb>到达|抵达|到)了。?",
    "request": "(?P<agent>我姐|我哥|我同事)(?P<outer_time>昨天|前天)?让(?P<author>我)(?P<time>周末|明天|后天)帮(?P<pronoun>她|他)顶个班。?",
    "plan": "如果(?P<condition>天晴)，(?P<author>我)计划(?P<time>明天|后天)(?P<only>只)?跑(?P<approx>约)?(?P<number>[1-9][0-9]{0,5}(?:\\.[0-9]{1,3})?)(?P<unit>公里|米)。?"
  },
  "ROLE_KINDS": [
    "author",
    "elder_sister",
    "elder_brother",
    "colleague",
    "vehicle",
    "book",
    "umbrella",
    "home",
    "company",
    "school",
    "airport",
    "station"
  ],
  "ROLE_SLOTS": [
    "agent",
    "recipient",
    "object",
    "property_owner",
    "beneficiary",
    "actor",
    "destination"
  ],
  "RELATION_TOKENS": {
    "我姐": "elder_sister",
    "我哥": "elder_brother",
    "我同事": "colleague"
  },
  "OBJECT_TOKENS": {
    "车": "vehicle",
    "书": "book",
    "雨伞": "umbrella"
  },
  "DESTINATION_TOKENS": {
    "家": "home",
    "公司": "company",
    "学校": "school",
    "机场": "airport",
    "车站": "station"
  },
  "TIME_TOKENS": {
    "刚": "just",
    "刚刚": "just",
    "昨天": "yesterday",
    "前天": "day_before_yesterday",
    "周末": "weekend",
    "明天": "tomorrow",
    "后天": "day_after_tomorrow"
  },
  "CAPABILITIES": [
    "subject_binding",
    "event_preservation",
    "reference_resolution",
    "direct_attribution",
    "reported_attribution",
    "temporal_preservation"
  ],
  "RULE_SET_SHA256": "e16c8381d07d82ca10bc2c05b0cb8dcef919e381c3fdfadf66cd10f002ed6f61"
} as const;
