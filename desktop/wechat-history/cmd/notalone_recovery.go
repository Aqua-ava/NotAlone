package main

import (
	"context"
	"sort"
	"strconv"
	"strings"
)

type notaloneRecoveryPosition struct {
	Partition      string   `json:"partition"`
	Table          string   `json:"table"`
	MaxLocalID     string   `json:"maxLocalId"`
	AnchorLocalIDs []string `json:"anchorLocalIds"`
}
type notaloneRecoveryResult struct {
	Target  notaloneSnapshotTarget   `json:"target"`
	Cursor  string                   `json:"cursor"`
	Anchors []notaloneSnapshotRecord `json:"anchors"`
}

func notaloneRecoveryCheckedFiles(previous, current []string) bool {
	if len(previous) != len(current) {
		return false
	}
	expected := map[string]bool{}
	for _, partition := range previous {
		if partition == "" || expected[partition] {
			return false
		}
		expected[partition] = true
	}
	for _, partition := range current {
		if !expected[partition] {
			return false
		}
		delete(expected, partition)
	}
	return len(expected) == 0
}

func notaloneRecoverySameInstances(previous, current notaloneSnapshotTarget) bool {
	previous.CheckedPartitions = append([]string(nil), previous.CheckedPartitions...)
	current.CheckedPartitions = append([]string(nil), current.CheckedPartitions...)
	sort.Strings(previous.CheckedPartitions)
	sort.Strings(current.CheckedPartitions)
	return notaloneSameSnapshotInstances(previous, current)
}

// 恢复只接受完整旧表水位；账号、会话及文件身份由当前选择与固定快照独立核验。
func notaloneRecoveryPositions(previous, current notaloneSnapshotTarget, positions []notaloneRecoveryPosition) (map[string]notaloneRecoveryPosition, error) {
	if previous.Protocol != "private-history-v1" || previous.SourceGeneration != current.SourceGeneration || len(previous.Tables) > 128 || len(positions) != len(previous.Tables) || len(previous.CheckedPartitions) > 0 && !notaloneRecoveryCheckedFiles(previous.CheckedPartitions, current.CheckedPartitions) {
		return nil, notaloneFailure("history_source_changed")
	}
	if !notaloneRecoverySameInstances(previous, current) && (len(previous.CheckedPartitions) == 0 || len(current.Tables) <= len(previous.Tables)) {
		return nil, notaloneFailure("history_source_changed")
	}
	currentPartitions := map[string]bool{}
	for _, partition := range current.Partitions {
		currentPartitions[partition] = true
	}
	priorPartitions := map[string]bool{}
	for _, partition := range previous.Partitions {
		if partition == "" || priorPartitions[partition] || !currentPartitions[partition] {
			return nil, notaloneFailure("history_source_changed")
		}
		priorPartitions[partition] = true
	}
	currentTables := map[string]string{}
	for _, table := range current.Tables {
		currentTables[table.Partition] = table.Instance
	}
	old := map[string]string{}
	for _, table := range previous.Tables {
		if table.Instance == "" || table.Partition == "" || old[table.Partition] != "" || currentTables[table.Partition] != table.Instance {
			return nil, notaloneFailure("history_source_changed")
		}
		old[table.Partition] = table.Instance
	}
	result := map[string]notaloneRecoveryPosition{}
	for _, position := range positions {
		max, e := strconv.ParseInt(position.MaxLocalID, 10, 64)
		if old[position.Partition] != position.Table || position.Table == "" || result[position.Partition].Table != "" || e != nil || max < 0 || strconv.FormatInt(max, 10) != position.MaxLocalID || len(position.AnchorLocalIDs) > 8 {
			return nil, notaloneFailure("history_checkpoint_invalid")
		}
		seen := map[string]bool{}
		for _, anchor := range position.AnchorLocalIDs {
			id, err := strconv.ParseInt(anchor, 10, 64)
			if err != nil || id < 0 || id > max || strconv.FormatInt(id, 10) != anchor || seen[anchor] {
				return nil, notaloneFailure("history_checkpoint_invalid")
			}
			seen[anchor] = true
		}
		result[position.Partition] = position
	}
	return result, nil
}

func (h *notaloneHistorySession) recoverTarget(ctx context.Context, r notaloneHistoryRequest, report notaloneSupportReport, profile *notaloneReadProfile) (any, error) {
	if report.Status != "supported" || profile == nil || report.Capabilities["recoverFromLocalIds"] != "supported" || h.snapshot == nil || h.snapshotMode != "normal" {
		return nil, notaloneFailure("history_tail_unsupported")
	}
	snapshot := h.snapshot
	target := snapshot.Target()
	positions, err := notaloneRecoveryPositions(*r.PreviousTarget, target, r.Positions)
	if err != nil {
		return nil, err
	}
	if !notaloneRecoverySameInstances(*r.PreviousTarget, target) && report.Capabilities["partitionGrowth"] != "supported" {
		return nil, notaloneFailure("history_source_changed")
	}
	if snapshot.deltaStates == nil {
		if err = snapshot.initializeDelta(ctx, h.server, nil, nil, false, nil); err != nil {
			return nil, err
		}
	}
	anchors, err := snapshot.recoverPositions(ctx, positions)
	if err != nil {
		return nil, err
	}
	cursor, err := notaloneSnapshotNonce()
	if err != nil {
		return nil, err
	}
	h.recoveryWatermarks = snapshot.watermarks
	if err = h.saveCheckpoint(report, *profile, target, cursor, snapshot.identityDigests, snapshot.deltaStates); err != nil {
		return nil, err
	}
	h.supportTargetChanged = false
	return notaloneRecoveryResult{Target: target, Cursor: cursor, Anchors: anchors}, nil
}

// 锚点查询有界且定点；普通Page保持原投影和守卫，只把各表起点移到已存最大键之后。
func (n *notaloneSnapshot) recoverPositions(ctx context.Context, positions map[string]notaloneRecoveryPosition) (anchors []notaloneSnapshotRecord, err error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err = n.checkLocked(); err != nil {
		return nil, err
	}
	if n.started {
		return nil, notaloneFailure("history_cursor_invalid")
	}
	anchors = []notaloneSnapshotRecord{}
	n.watermarks = map[string]string{}
	for _, shard := range n.shards {
		position, exists := positions[shard.partition]
		if !exists || !shard.present {
			continue
		}
		if len(position.AnchorLocalIDs) > 0 {
			query := "SELECT local_id,server_id,local_type,real_sender_id,create_time,status"
			if shard.hasContentTypeColumn {
				query += ",WCDB_CT_message_content"
			}
			query += " FROM " + quoteIdent(n.table) + " WHERE local_id IN (" + strings.TrimSuffix(strings.Repeat("?,", len(position.AnchorLocalIDs)), ",") + ") ORDER BY local_id"
			args := []any{}
			for _, id := range position.AnchorLocalIDs {
				numeric, _ := strconv.ParseInt(id, 10, 64)
				args = append(args, numeric)
			}
			rows, e := shard.reader.QueryBounded(ctx, 8, query, args...)
			if e != nil {
				return nil, notaloneReadFailure(e, "history_page_read_failed")
			}
			records, e := n.projectRows(ctx, shard, rows, nil)
			if e != nil {
				return nil, e
			}
			if e = n.recordIdentityDigests(shard, records); e != nil {
				return nil, e
			}
			anchors = append(anchors, records...)
		}
		max, _ := strconv.ParseInt(position.MaxLocalID, 10, 64)
		shard.lastID = &max
		n.watermarks[shard.partition] = position.MaxLocalID
	}
	if err = n.checkLocked(); err != nil {
		return nil, err
	}
	return anchors, nil
}
