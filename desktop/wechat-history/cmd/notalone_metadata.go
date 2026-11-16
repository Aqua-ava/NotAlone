package main

import "context"

type notaloneMetadataObservation struct {
	Partition        string  `json:"partition"`
	Table            string  `json:"table"`
	LocalID          *string `json:"localId"`
	ServerID         *string `json:"serverId"`
	OriginalType     *string `json:"originalType"`
	Status           *string `json:"status"`
	CreateTime       *string `json:"createTime"`
	Sender           string  `json:"sender"`
	StatusSemantics  string  `json:"statusSemantics"`
	NormalHistory    bool    `json:"normalHistory"`
	ObservationScope string  `json:"observationScope"`
}

func validNotaloneMetadataKind(kind string) bool {
	_, _, valid := notaloneMetadataFilter(kind)
	return valid
}

func notaloneMetadataFilter(kind string) (string, []any, bool) {
	const integerType = "typeof(local_type)='integer' AND (local_type & 4294967295)"
	switch kind {
	case "text":
		return integerType + "=?", []any{int64(1)}, true
	case "image":
		return integerType + "=?", []any{int64(3)}, true
	case "voice":
		return integerType + "=?", []any{int64(34)}, true
	case "video":
		return integerType + " IN (?,?)", []any{int64(43), int64(62)}, true
	case "file":
		return integerType + "=?", []any{int64(49)}, true
	case "sticker":
		return integerType + "=?", []any{int64(47)}, true
	case "other":
		return "typeof(local_type)<>'integer' OR (local_type & 4294967295) NOT IN (1,3,34,43,62,47,49)", nil, true
	default:
		return "", nil, false
	}
}

// 诊断只观察本次固定切面的一条元数据，不授权普通历史读取或解释未知状态。
func observeNotaloneMessageMetadata(ctx context.Context, s *server, selected notaloneResolved, inspection notaloneInspection, kind string) (observation *notaloneMetadataObservation, err error) {
	if !validNotaloneMetadataKind(kind) {
		return nil, notaloneFailure("history_metadata_kind_invalid")
	}
	if ctx == nil || ctx.Err() != nil {
		return nil, notaloneFailure("history_snapshot_cancelled")
	}
	if s == nil || s.cfg == nil {
		return nil, notaloneFailure("history_scope_unverified")
	}
	session := &notaloneHistorySession{server: s}
	if err = session.currentAccount(); err != nil {
		return nil, err
	}
	snapshot, err := newNotaloneSnapshot(ctx, s, selected, inspection, notaloneReadProfile{SchemaShapeFingerprint: notaloneSnapshotShape(inspection.Tables), OpaqueStatusPolicy: "snapshot-opaque-v1"})
	if err != nil {
		return nil, err
	}
	defer func() {
		if closeErr := snapshot.Close(); closeErr != nil && err == nil {
			observation, err = nil, notaloneFailure("history_snapshot_close_failed")
		}
		if ctx.Err() != nil && err == nil {
			observation, err = nil, notaloneFailure("history_snapshot_cancelled")
		}
	}()
	observation, err = snapshot.observeMetadata(ctx, kind)
	if err == nil {
		if err = session.currentAccount(); err != nil {
			observation = nil
		}
	}
	return observation, err
}

func (n *notaloneSnapshot) observeMetadata(ctx context.Context, kind string) (*notaloneMetadataObservation, error) {
	filter, args, valid := notaloneMetadataFilter(kind)
	if !valid {
		return nil, notaloneFailure("history_metadata_kind_invalid")
	}
	if ctx == nil || ctx.Err() != nil {
		return nil, notaloneFailure("history_snapshot_cancelled")
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.checkLocked(); err != nil {
		return nil, err
	}
	op, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(n.life, cancel)
	defer func() { stop(); cancel() }()
	var observation *notaloneMetadataObservation
	for _, shard := range n.shards {
		if !shard.present {
			continue
		}
		// 不经Page/projectRows；SQL列清单不包含正文、source、XML或媒体字段。
		rows, err := shard.reader.QueryBounded(op, 1, "SELECT local_id,server_id,local_type,status,real_sender_id,create_time FROM "+quoteIdent(n.table)+" WHERE "+filter+" ORDER BY local_id LIMIT 1", args...)
		if op.Err() != nil {
			return nil, notaloneFailure("history_snapshot_cancelled")
		}
		if err != nil {
			return nil, notaloneReadFailure(err, "history_metadata_unavailable")
		}
		if len(rows) == 0 {
			continue
		}
		row := rows[0]
		observation = &notaloneMetadataObservation{Partition: shard.partition, Table: shard.instance, LocalID: notaloneSnapshotDecimal(row["local_id"]), ServerID: notaloneSnapshotDecimal(row["server_id"]), OriginalType: notaloneSnapshotDecimal(row["local_type"]), Status: notaloneSnapshotDecimal(row["status"]), CreateTime: notaloneSnapshotDecimal(row["create_time"]), Sender: "unknown", StatusSemantics: "unverified", NormalHistory: false, ObservationScope: "single-fixed-snapshot"}
		if senderID, known := row["real_sender_id"].(int64); known {
			names, err := shard.reader.QueryBounded(op, 1, "SELECT user_name FROM Name2Id WHERE rowid=? LIMIT 1", senderID)
			if notaloneIsTemporaryReadFailure(err) {
				return nil, notaloneReadFailure(err, "history_metadata_unavailable")
			}
			if err == nil && len(names) == 1 {
				switch rowString(names[0], "user_name") {
				case n.senderOwner:
					observation.Sender = "owner"
				case n.selected.Conversation:
					observation.Sender = "contact"
				}
			}
		}
		break
	}
	if op.Err() != nil {
		return nil, notaloneFailure("history_snapshot_cancelled")
	}
	if err := n.checkLocked(); err != nil {
		return nil, err
	}
	return observation, nil
}
