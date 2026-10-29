package main

import (
	"context"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

type notaloneTestMetadataReport struct {
	Format            string                         `json:"format"`
	Status            string                         `json:"status"`
	ScopeDigest       string                         `json:"scopeDigest"`
	SourceGeneration  string                         `json:"sourceGeneration"`
	SchemaFingerprint string                         `json:"schemaFingerprint"`
	Action            string                         `json:"action"`
	CheckedPartitions []string                       `json:"checkedPartitions"`
	LockedCount       int                            `json:"lockedCount"`
	Records           []*notaloneMetadataObservation `json:"records"`
}
type notaloneTestMetadataKey struct {
	partition, table string
	id               int64
}
type notaloneTestMetadataWatch struct {
	mu                        sync.Mutex
	life                      context.Context
	cancel                    context.CancelFunc
	guard                     *notaloneSourceGuard
	baseline                  map[string]*int64
	locked                    []notaloneTestMetadataKey
	schema, scope, generation string
	started                   time.Time
	calls                     int
	closed                    bool
}

func newNotaloneTestMetadataWatch() *notaloneTestMetadataWatch {
	life, cancel := context.WithCancel(context.Background())
	return &notaloneTestMetadataWatch{life: life, cancel: cancel}
}
func validNotaloneTestMetadataAction(action string) bool {
	return action == "arm" || action == "next" || action == "current"
}
func (w *notaloneTestMetadataWatch) Close() error {
	w.cancel()
	w.mu.Lock()
	defer w.mu.Unlock()
	w.closed = true
	if w.guard != nil {
		return w.guard.Close()
	}
	return nil
}

// 开发验收仅以逐阶段唯一新增行建立时序关联，不读取正文，也不认证状态语义。
func (w *notaloneTestMetadataWatch) observe(ctx context.Context, s *server, selected notaloneResolved, inspection notaloneInspection, action string) (report notaloneTestMetadataReport, err error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !validNotaloneTestMetadataAction(action) || (action == "arm" && !w.started.IsZero()) {
		return report, notaloneFailure("history_request_invalid")
	}
	if w.closed || w.life.Err() != nil || (action != "arm" && w.baseline == nil) || w.calls >= 20 || (!w.started.IsZero() && time.Since(w.started) > 10*time.Minute) {
		return report, notaloneFailure("history_snapshot_closed")
	}
	if ctx == nil || ctx.Err() != nil {
		return report, notaloneFailure("history_snapshot_cancelled")
	}
	defer func() {
		if err != nil {
			w.closed = true
			w.cancel()
			if w.guard != nil {
				_ = w.guard.Close()
			}
		}
	}()
	if action == "arm" {
		w.started = time.Now()
		for _, table := range inspection.Tables {
			if !table.AutoIncrement || len(table.DeclaredPrimaryKey) != 1 || table.DeclaredPrimaryKey[0] != "local_id" {
				return report, notaloneFailure("history_identity_unverified")
			}
		}
		directory := filepath.Join(s.cfg.DBRoot, "db_storage", "message")
		files, e := notaloneSnapshotFiles(directory)
		if e != nil {
			return report, e
		}
		w.guard, err = newNotaloneSourceGuard(directory, files)
		if err != nil {
			return report, err
		}
		w.schema, w.scope, w.generation = inspection.SchemaFingerprint, inspection.ScopeDigest, inspection.SourceGeneration
		w.started = time.Now()
	} else if w.schema != inspection.SchemaFingerprint || w.scope != inspection.ScopeDigest || w.generation != inspection.SourceGeneration {
		return report, notaloneFailure("history_schema_changed")
	}
	if w.guard.Check() != nil {
		return report, notaloneFailure("history_source_changed")
	}
	w.calls++
	ctx, cancelWatch := context.WithCancel(ctx)
	stopWatch := context.AfterFunc(w.life, cancelWatch)
	defer func() { stopWatch(); cancelWatch() }()
	snapshot, e := newNotaloneSnapshot(ctx, s, selected, inspection, notaloneReadProfile{SchemaShapeFingerprint: notaloneSnapshotShape(inspection.Tables), OpaqueStatusPolicy: "snapshot-opaque-v1"})
	if e != nil {
		return report, e
	}
	defer func() {
		if e := snapshot.Close(); e != nil && err == nil {
			report, err = notaloneTestMetadataReport{}, notaloneFailure("history_snapshot_close_failed")
		}
	}()
	snapshot.mu.Lock()
	defer snapshot.mu.Unlock()
	if err = snapshot.checkLocked(); err != nil {
		return report, err
	}
	op, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(snapshot.life, cancel)
	defer func() { stop(); cancel() }()
	if action == "arm" {
		w.baseline, err = snapshot.testMetadataBaseline(op)
	}
	if action == "next" {
		if len(w.locked) >= 2 {
			return report, notaloneFailure("history_request_invalid")
		}
		var candidate *notaloneSnapshotShard
		total := int64(0)
		for _, shard := range snapshot.shards {
			if !shard.present {
				continue
			}
			where, args := notaloneTestMetadataAfter(w.baseline[shard.partition])
			rows, e := shard.reader.QueryBounded(op, 1, "SELECT count(*) AS count FROM (SELECT 1 FROM "+quoteIdent(snapshot.table)+where+" LIMIT 2)", args...)
			if e != nil || len(rows) != 1 {
				return report, notaloneFailure("history_metadata_unavailable")
			}
			count, ok := rows[0]["count"].(int64)
			if !ok || count < 0 {
				return report, notaloneFailure("history_metadata_unavailable")
			}
			total += count
			if total > 1 {
				return report, notaloneFailure("history_identity_ambiguous")
			}
			if count == 1 {
				candidate = shard
			}
		}
		if candidate != nil {
			where, args := notaloneTestMetadataAfter(w.baseline[candidate.partition])
			record, e := snapshot.testMetadataRecord(op, candidate, where, args...)
			if e != nil {
				return report, e
			}
			if record == nil || record.LocalID == nil || record.OriginalType == nil || record.Sender != "owner" {
				return report, notaloneFailure("history_identity_ambiguous")
			}
			typeID, e := strconv.ParseInt(*record.OriginalType, 10, 64)
			if e != nil || uint64(typeID)&0xffffffff != 1 {
				return report, notaloneFailure("history_identity_ambiguous")
			}
			id, e := strconv.ParseInt(*record.LocalID, 10, 64)
			if e != nil {
				return report, notaloneFailure("history_identity_ambiguous")
			}
			baseline, e := snapshot.testMetadataBaseline(op)
			if e != nil {
				return report, e
			}
			w.locked = append(w.locked, notaloneTestMetadataKey{candidate.partition, candidate.instance, id})
			w.baseline = baseline
		}
	}
	if err != nil {
		return report, err
	}
	records := make([]*notaloneMetadataObservation, 0, len(w.locked))
	for _, key := range w.locked {
		var shard *notaloneSnapshotShard
		for _, item := range snapshot.shards {
			if item.present && item.partition == key.partition && item.instance == key.table {
				shard = item
				break
			}
		}
		if shard == nil {
			return report, notaloneFailure("history_source_changed")
		}
		record, e := snapshot.testMetadataRecord(op, shard, " WHERE local_id=?", key.id)
		if e != nil {
			return report, e
		}
		records = append(records, record)
	}
	if op.Err() != nil {
		return report, notaloneFailure("history_snapshot_cancelled")
	}
	if err = snapshot.checkLocked(); err != nil {
		return report, err
	}
	if w.guard.Check() != nil {
		return report, notaloneFailure("history_source_changed")
	}
	return notaloneTestMetadataReport{"wechat-test-metadata-observation-v1", "unverified", inspection.ScopeDigest, inspection.SourceGeneration, inspection.SchemaFingerprint, action, inspection.CheckedPartitions, len(w.locked), records}, nil
}
func notaloneTestMetadataAfter(id *int64) (string, []any) {
	if id == nil {
		return "", nil
	}
	return " WHERE local_id>?", []any{*id}
}
func (n *notaloneSnapshot) testMetadataBaseline(ctx context.Context) (map[string]*int64, error) {
	result := map[string]*int64{}
	for _, shard := range n.shards {
		if !shard.present {
			continue
		}
		rows, err := shard.reader.QueryBounded(ctx, 1, "SELECT MAX(local_id) AS maximum FROM "+quoteIdent(n.table))
		if err != nil || len(rows) != 1 {
			return nil, notaloneFailure("history_metadata_unavailable")
		}
		if rows[0]["maximum"] == nil {
			result[shard.partition] = nil
			continue
		}
		maximum, ok := rows[0]["maximum"].(int64)
		if !ok {
			return nil, notaloneFailure("history_identity_unverified")
		}
		result[shard.partition] = &maximum
	}
	return result, nil
}
func (n *notaloneSnapshot) testMetadataRecord(ctx context.Context, shard *notaloneSnapshotShard, where string, args ...any) (*notaloneMetadataObservation, error) {
	rows, err := shard.reader.QueryBounded(ctx, 1, "SELECT local_id,server_id,local_type,status,real_sender_id,create_time FROM "+quoteIdent(n.table)+where+" LIMIT 1", args...)
	if err != nil {
		return nil, notaloneFailure("history_metadata_unavailable")
	}
	if len(rows) == 0 {
		return nil, nil
	}
	row := rows[0]
	r := &notaloneMetadataObservation{Partition: shard.partition, Table: shard.instance, LocalID: notaloneSnapshotDecimal(row["local_id"]), ServerID: notaloneSnapshotDecimal(row["server_id"]), OriginalType: notaloneSnapshotDecimal(row["local_type"]), Status: notaloneSnapshotDecimal(row["status"]), CreateTime: notaloneSnapshotDecimal(row["create_time"]), Sender: "unknown", StatusSemantics: "unverified", NormalHistory: false, ObservationScope: "single-fixed-snapshot"}
	if id, ok := row["real_sender_id"].(int64); ok {
		names, err := shard.reader.QueryBounded(ctx, 1, "SELECT user_name FROM Name2Id WHERE rowid=? LIMIT 1", id)
		if err != nil {
			return nil, notaloneFailure("history_metadata_unavailable")
		}
		if len(names) == 1 {
			switch rowString(names[0], "user_name") {
			case n.selected.Account:
				r.Sender = "owner"
			case n.selected.Conversation:
				r.Sender = "contact"
			}
		}
	}
	return r, nil
}
