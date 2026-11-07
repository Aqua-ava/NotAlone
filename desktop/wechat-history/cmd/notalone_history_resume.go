package main

import (
	"sort"
	"strconv"
)

// 页索引覆盖整个固定切面，摘要只代表已接受且未变化的行。
// 恢复时重新枚举尚无摘要的成员；不把旧分页位置当成新快照的完整性证据。
func (n *notaloneSnapshot) restorePendingHistory(pending []notaloneTailIdentity) error {
	for _, shard := range n.shards {
		if !shard.present {
			continue
		}
		state, ok := n.deltaStates[shard.partition]
		if !ok {
			return notaloneFailure("history_checkpoint_invalid")
		}
		ids := map[int64]bool{}
		for _, id := range n.deltaIDs[shard.partition] {
			ids[id] = true
		}
		rawWatermark, hasWatermark := n.watermarks[shard.partition]
		watermark, _ := strconv.ParseInt(rawWatermark, 10, 64)
		for _, page := range state.Pages.Pages {
			if page.Kind != notaloneDeltaPageLeaf {
				continue
			}
			for _, id := range page.RowIDs {
				if hasWatermark && id <= watermark {
					continue
				}
				identity := notaloneTailIdentity{Partition: shard.partition, Table: shard.instance, LocalID: strconv.FormatInt(id, 10)}
				if _, accepted := n.identityDigests[identity]; !accepted {
					ids[id] = true
				}
			}
		}
		for _, identity := range pending {
			if identity.Partition != shard.partition {
				continue
			}
			id, err := strconv.ParseInt(identity.LocalID, 10, 64)
			if err != nil || id < 0 || identity.Table != shard.instance {
				return notaloneFailure("history_checkpoint_invalid")
			}
			ids[id] = true
			n.deltaMissing[identity] = true
			delete(n.identityDigests, identity)
		}
		n.deltaIDs[shard.partition] = make([]int64, 0, len(ids))
		for id := range ids {
			n.deltaIDs[shard.partition] = append(n.deltaIDs[shard.partition], id)
		}
		sort.Slice(n.deltaIDs[shard.partition], func(i, j int) bool { return n.deltaIDs[shard.partition][i] < n.deltaIDs[shard.partition][j] })
	}
	return nil
}
