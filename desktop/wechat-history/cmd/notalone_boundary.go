package main

import (
	"context"
	"sort"
	"strconv"
	"time"
)

const (
	notaloneBoundaryFormat         = "wechat-history-boundary-v1"
	notaloneBoundaryCapability     = "private-history-boundary-v1"
	notaloneBoundaryConsent        = "selected-history-boundary-v1"
	notaloneBoundaryMemberLimit    = 100_000
	notaloneBoundaryQueryBatch     = 256
	notaloneBoundaryReadMaxRetries = 3
)

type notaloneBoundaryMember struct {
	Partition string `json:"partition"`
	Table     string `json:"table"`
	LocalID   string `json:"localId"`
}

type notaloneBoundaryPartition struct {
	Partition       string `json:"partition"`
	Instance        string `json:"instance"`
	PreSample       string `json:"preSample"`
	PostSample      string `json:"postSample"`
	ReaderCompleted bool   `json:"readerCompleted"`
	MemberCount     int    `json:"memberCount"`
}

type notaloneBoundarySnapshotReport struct {
	Format              string                      `json:"format"`
	ScopeDigest         string                      `json:"scopeDigest"`
	SourceGeneration    string                      `json:"sourceGeneration"`
	SchemaFingerprint   string                      `json:"schemaFingerprint"`
	Target              notaloneSnapshotTarget      `json:"target"`
	BoundaryToken       string                      `json:"boundaryToken"`
	Members             []notaloneBoundaryMember    `json:"members"`
	Partitions          []notaloneBoundaryPartition `json:"partitions"`
	NamespaceContinuity bool                        `json:"namespaceContinuity"`
	InstanceContinuity  bool                        `json:"instanceContinuity"`
	ObservedAt          string                      `json:"observedAt"`
}

// boundarySnapshot 只在 profile 明确编译了 S(B) 语义时使用；正式微信 profile 默认关闭。
// 每次失败的固定窗口最多重试三次；来源命名空间、表实例或身份发生变化时不重试。
func (h *notaloneHistorySession) boundarySnapshot(ctx context.Context) (notaloneBoundarySnapshotReport, error) {
	var empty notaloneBoundarySnapshotReport
	if h == nil || h.server == nil || h.server.cfg == nil || h.selected == nil || h.inspected == nil || h.life == nil || ctx == nil {
		return empty, notaloneFailure("history_boundary_scope_invalid")
	}
	if ctx.Err() != nil || h.life.Err() != nil {
		return empty, notaloneFailure("history_snapshot_cancelled")
	}
	if h.selected.Account != h.server.cfg.Wxid || h.selected.SourceGeneration == "" {
		return empty, notaloneFailure("history_scope_unverified")
	}
	if err := h.currentAccount(); err != nil {
		return empty, notaloneFailure("history_account_changed")
	}
	if err := h.ensureMessageGuard(); err != nil {
		return empty, err
	}
	report, profile, err := h.support(ctx)
	if err != nil {
		return empty, err
	}
	if profile == nil || !profile.BoundarySemanticsVerified || report.Capabilities["private-history-boundary-v1"] != "supported" ||
		report.Capabilities["programVersion"] != "supported" ||
		report.Capabilities["exactSchema"] != "supported" ||
		report.Capabilities["declaredLocalKey"] != "supported" ||
		report.Capabilities[notaloneBoundaryCapability] != "supported" {
		return empty, notaloneFailure("history_boundary_support_unverified")
	}
	if profile.SchemaShapeFingerprint == "" || profile.SchemaShapeFingerprint != notaloneSnapshotShape(h.inspected.Tables) {
		return empty, notaloneFailure("history_schema_changed")
	}
	if report.SchemaFingerprint != h.inspected.SchemaFingerprint {
		return empty, notaloneFailure("history_schema_changed")
	}
	// 仅用于读取固定reader的 local_id；不把状态语义带入S(B)。
	boundaryProfile := *profile
	if !boundaryProfile.StatusSemanticsVerified {
		boundaryProfile.OpaqueStatusPolicy = "snapshot-opaque-v1"
	}
	var lastErr error
	for attempt := 0; attempt < notaloneBoundaryReadMaxRetries; attempt++ {
		if ctx.Err() != nil || h.life.Err() != nil {
			return empty, notaloneFailure("history_snapshot_cancelled")
		}
		attemptCtx, cancelAttempt := notaloneBoundaryAttemptContext(ctx, h.life)
		snapshot, openErr := newNotaloneSnapshot(attemptCtx, h.server, *h.selected, *h.inspected, boundaryProfile)
		if openErr != nil {
			cancelAttempt()
			lastErr = openErr
			if openErr.Error() == "history_snapshot_window_changed" && attempt+1 < notaloneBoundaryReadMaxRetries {
				continue
			}
			return empty, openErr
		}
		boundary, readErr := notaloneBoundaryMembers(ctx, snapshot, h.inspected.SchemaFingerprint)
		closeErr := snapshot.Close()
		cancelAttempt()
		if readErr == nil && closeErr == nil {
			if err = h.currentAccount(); err != nil {
				return empty, notaloneFailure("history_account_changed")
			}
			if err = h.ensureMessageGuard(); err != nil {
				return empty, err
			}
			return boundary, nil
		}
		if readErr != nil {
			lastErr = readErr
		} else {
			lastErr = notaloneFailure("history_snapshot_close_failed")
		}
		if lastErr.Error() == "history_snapshot_window_changed" && attempt+1 < notaloneBoundaryReadMaxRetries {
			continue
		}
		return empty, lastErr
	}
	if lastErr == nil {
		lastErr = notaloneFailure("history_snapshot_window_changed")
	}
	return empty, lastErr
}

func notaloneBoundaryAttemptContext(request, session context.Context) (context.Context, context.CancelFunc) {
	attempt, cancel := context.WithCancel(request)
	stopSession := context.AfterFunc(session, cancel)
	return attempt, func() {
		stopSession()
		cancel()
	}
}

// notaloneBoundaryMembers 在已BEGIN并固定的快照上只读取声明主键；不会走 Page/projectRows。
func notaloneBoundaryMembers(ctx context.Context, snapshot *notaloneSnapshot, schemaFingerprint string) (notaloneBoundarySnapshotReport, error) {
	var empty notaloneBoundarySnapshotReport
	if ctx == nil || snapshot == nil || snapshot.life == nil || schemaFingerprint == "" {
		return empty, notaloneFailure("history_boundary_scope_invalid")
	}
	if ctx.Err() != nil {
		return empty, notaloneFailure("history_snapshot_cancelled")
	}
	op, cancel := context.WithCancel(ctx)
	stopLife := context.AfterFunc(snapshot.life, cancel)
	defer func() {
		stopLife()
		cancel()
	}()
	snapshot.mu.Lock()
	defer snapshot.mu.Unlock()
	if err := snapshot.checkLocked(); err != nil {
		return empty, err
	}
	if !snapshot.profile.BoundarySemanticsVerified {
		return empty, notaloneFailure("history_boundary_support_unverified")
	}
	if len(snapshot.target.Tables) == 0 || len(snapshot.shards) == 0 {
		return empty, notaloneFailure("history_boundary_candidate_incomplete")
	}
	partitionInstances := make(map[string]string, len(snapshot.target.Tables))
	for _, table := range snapshot.target.Tables {
		if table.Partition == "" || table.Instance == "" || partitionInstances[table.Partition] != "" {
			return empty, notaloneFailure("history_boundary_instance_changed")
		}
		partitionInstances[table.Partition] = table.Instance
	}
	shards := append([]*notaloneSnapshotShard(nil), snapshot.shards...)
	sort.Slice(shards, func(i, j int) bool { return shards[i].partition < shards[j].partition })
	members := make([]notaloneBoundaryMember, 0)
	counts := make(map[string]int, len(partitionInstances))
	for partition := range partitionInstances {
		counts[partition] = 0
	}
	for _, shard := range shards {
		if err := snapshot.checkLocked(); err != nil {
			return empty, err
		}
		instance, inTarget := partitionInstances[shard.partition]
		if shard.present != inTarget || (inTarget && (instance != shard.instance || shard.reader == nil)) {
			return empty, notaloneFailure("history_boundary_instance_changed")
		}
		if !shard.present {
			continue
		}
		var cursor *int64
		for {
			if op.Err() != nil || snapshot.life.Err() != nil {
				return empty, notaloneFailure("history_snapshot_cancelled")
			}
			if err := snapshot.checkLocked(); err != nil {
				return empty, err
			}
			remaining := notaloneBoundaryMemberLimit - len(members)
			if remaining < 0 {
				return empty, notaloneFailure("history_boundary_member_limit")
			}
			limit := notaloneBoundaryQueryBatch
			if remaining < limit {
				// 接近上限时至多再读remaining+1行，以精确识别超限。
				limit = remaining + 1
			}
			query := "SELECT local_id FROM " + quoteIdent(snapshot.table)
			args := []any{}
			if cursor != nil {
				query += " WHERE local_id>?"
				args = append(args, *cursor)
			}
			query += " ORDER BY local_id LIMIT ?"
			args = append(args, int64(limit))
			rows, err := shard.reader.QueryBounded(op, limit, query, args...)
			if err != nil {
				if op.Err() != nil || snapshot.life.Err() != nil {
					return empty, notaloneFailure("history_snapshot_cancelled")
				}
				return empty, notaloneFailure("history_boundary_read_failed")
			}
			if op.Err() != nil || snapshot.life.Err() != nil {
				return empty, notaloneFailure("history_snapshot_cancelled")
			}
			if len(rows) > remaining {
				return empty, notaloneFailure("history_boundary_member_limit")
			}
			for _, row := range rows {
				id, ok := row["local_id"].(int64)
				if !ok || id < 0 {
					return empty, notaloneFailure("history_boundary_member_invalid")
				}
				localID := strconv.FormatInt(id, 10)
				members = append(members, notaloneBoundaryMember{Partition: shard.partition, Table: shard.instance, LocalID: localID})
				cursor = &id
				counts[shard.partition]++
			}
			if len(rows) < limit {
				break
			}
		}
	}
	if err := snapshot.checkLocked(); err != nil {
		return empty, err
	}
	evidence, namespaceContinuity, instanceContinuity, proofErr := snapshot.boundaryEvidence()
	if proofErr != nil {
		return empty, proofErr
	}
	if !namespaceContinuity {
		return empty, notaloneFailure("history_source_changed")
	}
	if !instanceContinuity {
		return empty, notaloneFailure("history_boundary_instance_changed")
	}
	if len(evidence) != len(partitionInstances) {
		return empty, notaloneFailure("history_boundary_candidate_incomplete")
	}
	evidencePartitions := make(map[string]bool, len(evidence))
	for index := range evidence {
		count, present := counts[evidence[index].Partition]
		expectedInstance, inTarget := partitionInstances[evidence[index].Partition]
		if evidencePartitions[evidence[index].Partition] || !present || !inTarget || evidence[index].Instance != expectedInstance ||
			evidence[index].PreSample == "" ||
			evidence[index].PostSample == "" || evidence[index].PreSample != evidence[index].PostSample {
			return empty, notaloneFailure("history_boundary_candidate_incomplete")
		}
		evidencePartitions[evidence[index].Partition] = true
		evidence[index].ReaderCompleted = true
		evidence[index].MemberCount = count
	}
	sort.Slice(evidence, func(i, j int) bool { return evidence[i].Partition < evidence[j].Partition })
	if op.Err() != nil || snapshot.life.Err() != nil {
		return empty, notaloneFailure("history_snapshot_cancelled")
	}
	if snapshot.guard.Check() != nil {
		return empty, notaloneFailure("history_source_changed")
	}
	observedAt := time.Now().UTC().Format(time.RFC3339Nano)
	boundaryToken, err := notaloneSnapshotNonce()
	if err != nil {
		return empty, err
	}
	target := snapshot.target
	target.Partitions = append([]string(nil), snapshot.target.Partitions...)
	target.Tables = append([]notaloneSnapshotTable(nil), snapshot.target.Tables...)
	target.CheckedPartitions = append([]string(nil), snapshot.target.CheckedPartitions...)
	return notaloneBoundarySnapshotReport{
		Format:              notaloneBoundaryFormat,
		ScopeDigest:         notaloneHash(snapshot.selected.Account, snapshot.selected.Conversation),
		SourceGeneration:    snapshot.selected.SourceGeneration,
		SchemaFingerprint:   schemaFingerprint,
		Target:              target,
		BoundaryToken:       boundaryToken,
		Members:             members,
		Partitions:          evidence,
		NamespaceContinuity: namespaceContinuity,
		InstanceContinuity:  instanceContinuity,
		ObservedAt:          observedAt,
	}, nil
}
