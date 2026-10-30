package main

import (
	"context"
	"strconv"
)

const notaloneFixedSnapshotProofFormat = "wechat-history-fixed-snapshot-proof-v1"

type notaloneFixedSnapshotPartitionProof struct {
	Partition          string  `json:"partition"`
	TablePresent       bool    `json:"tablePresent"`
	Instance           *string `json:"instance"`
	PreSample          string  `json:"preSample"`
	PostSample         string  `json:"postSample"`
	ReaderPinned       bool    `json:"readerPinned"`
	SourceInstanceHeld bool    `json:"sourceInstanceHeld"`
}

type notaloneFixedSnapshotProof struct {
	Format                   string                                `json:"format"`
	Status                   string                                `json:"status"`
	ScopeDigest              string                                `json:"scopeDigest"`
	SourceGeneration         string                                `json:"sourceGeneration"`
	SchemaFingerprint        string                                `json:"schemaFingerprint"`
	ExpectedPartitionCount   int                                   `json:"expectedPartitionCount"`
	CompletedPartitionCount  int                                   `json:"completedPartitionCount"`
	NamespaceContinuity      bool                                  `json:"namespaceContinuity"`
	InstanceContinuity       bool                                  `json:"instanceContinuity"`
	SnapshotBarrier          bool                                  `json:"snapshotBarrier"`
	Scope                    string                                `json:"scope"`
	AuthorizesSubsequentRead bool                                  `json:"authorizesSubsequentRead"`
	Partitions               []notaloneFixedSnapshotPartitionProof `json:"partitions"`
}

// FixedSnapshotProof 仅报告本次获取已经持有的证据，不允许恢复或打开后续快照，也不查询消息行或正文。
func (n *notaloneSnapshot) FixedSnapshotProof(inspection notaloneInspection) (notaloneFixedSnapshotProof, error) {
	var empty notaloneFixedSnapshotProof
	if n == nil || inspection.ScopeDigest != notaloneHash(n.selected.Account, n.selected.Conversation) ||
		inspection.SourceGeneration != n.selected.SourceGeneration || inspection.SchemaFingerprint == "" || inspection.SchemaFingerprint != n.schemaFingerprint ||
		len(n.shards) == 0 || len(n.checkedPartitions) == 0 || len(n.checkedPartitions) != len(n.shards) {
		return empty, notaloneFailure("history_snapshot_proof_incomplete")
	}
	if len(inspection.CheckedPartitions) != len(n.checkedPartitions) {
		return empty, notaloneFailure("history_snapshot_proof_incomplete")
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.checkLocked(); err != nil {
		return empty, err
	}
	emptyTarget := len(inspection.Tables) == 0 && len(n.target.Tables) == 0
	if emptyTarget {
		if len(n.target.Partitions) != len(n.checkedPartitions) {
			return empty, notaloneFailure("history_snapshot_proof_incomplete")
		}
	} else if len(n.target.Partitions) != len(n.target.Tables) || len(n.target.Tables) == 0 {
		return empty, notaloneFailure("history_snapshot_proof_incomplete")
	}
	expected := make(map[string]bool, len(n.checkedPartitions))
	for _, partition := range n.checkedPartitions {
		if partition == "" || expected[partition] {
			return empty, notaloneFailure("history_snapshot_proof_incomplete")
		}
		expected[partition] = true
	}
	passed := make(map[string]bool, len(inspection.CheckedPartitions))
	for _, partition := range inspection.CheckedPartitions {
		if partition == "" || passed[partition] || !expected[partition] {
			return empty, notaloneFailure("history_snapshot_proof_incomplete")
		}
		passed[partition] = true
	}
	if len(passed) != len(expected) {
		return empty, notaloneFailure("history_snapshot_proof_incomplete")
	}
	targetInstances := make(map[string]string, len(n.target.Tables))
	for _, table := range n.target.Tables {
		if table.Partition == "" || table.Instance == "" || targetInstances[table.Partition] != "" {
			return empty, notaloneFailure("history_snapshot_proof_incomplete")
		}
		targetInstances[table.Partition] = table.Instance
	}
	proof := notaloneFixedSnapshotProof{
		Format: notaloneFixedSnapshotProofFormat, Status: "verified", ScopeDigest: inspection.ScopeDigest,
		SourceGeneration: inspection.SourceGeneration, SchemaFingerprint: inspection.SchemaFingerprint,
		ExpectedPartitionCount: len(expected), NamespaceContinuity: true, InstanceContinuity: true,
		SnapshotBarrier: true, Scope: "single-fixed-snapshot", AuthorizesSubsequentRead: false,
		Partitions: make([]notaloneFixedSnapshotPartitionProof, 0, len(n.shards)),
	}
	seen := make(map[string]bool, len(n.shards))
	for _, shard := range n.shards {
		if shard == nil || shard.partition == "" || seen[shard.partition] || !expected[shard.partition] ||
			shard.reader == nil || shard.observer == nil || !shard.pinned || shard.observerPre < 0 ||
			shard.observerPost < 0 || shard.observerPre != shard.observerPost {
			return empty, notaloneFailure("history_snapshot_proof_incomplete")
		}
		seen[shard.partition] = true
		instance, targetHasInstance := targetInstances[shard.partition]
		var instanceValue *string
		if shard.present {
			if !targetHasInstance || shard.instance == "" || instance != shard.instance {
				return empty, notaloneFailure("history_snapshot_proof_incomplete")
			}
			actual, err := inspectNotaloneTable(n.life, shard.reader, n.table, shard.partition)
			if err != nil || actual.Target != shard.instance {
				return empty, notaloneFailure("history_schema_changed")
			}
			value := shard.instance
			instanceValue = &value
		} else if targetHasInstance || shard.instance != "" {
			return empty, notaloneFailure("history_snapshot_proof_incomplete")
		}
		fileInstance, err := n.guard.FileFingerprint(shard.path)
		if err != nil || fileInstance != shard.partition {
			return empty, notaloneFailure("history_source_changed")
		}
		proof.Partitions = append(proof.Partitions, notaloneFixedSnapshotPartitionProof{
			Partition: shard.partition, TablePresent: shard.present, Instance: instanceValue,
			PreSample: strconv.FormatInt(shard.observerPre, 10), PostSample: strconv.FormatInt(shard.observerPost, 10),
			ReaderPinned: true, SourceInstanceHeld: true,
		})
	}
	if emptyTarget {
		targetPartitions := map[string]bool{}
		for _, partition := range n.target.Partitions {
			if !expected[partition] || targetPartitions[partition] {
				return empty, notaloneFailure("history_snapshot_proof_incomplete")
			}
			targetPartitions[partition] = true
		}
	}
	if len(seen) != len(expected) || !emptyTarget && len(targetInstances) != len(n.target.Partitions) {
		return empty, notaloneFailure("history_snapshot_proof_incomplete")
	}
	proof.CompletedPartitionCount = len(seen)
	if err := n.checkLocked(); err != nil {
		return empty, err
	}
	return proof, nil
}

// verifyFixedSnapshotMetadata 打开并关闭一个不读取正文的固定快照，不返回目标或游标，也不调用 Page。
func (h *notaloneHistorySession) verifyFixedSnapshotMetadata(ctx context.Context) (notaloneFixedSnapshotProof, error) {
	var empty notaloneFixedSnapshotProof
	if h == nil || h.server == nil || h.selected == nil || ctx == nil || ctx.Err() != nil || h.testMetadata != nil || h.receivedTestMetadata != nil {
		return empty, notaloneFailure("history_snapshot_unavailable")
	}
	if err := h.currentAccount(); err != nil {
		return empty, err
	}
	if err := h.ensureMessageGuard(); err != nil {
		return empty, err
	}
	if h.snapshot != nil {
		if h.inspected == nil {
			return empty, notaloneFailure("history_snapshot_proof_incomplete")
		}
		proof, err := h.snapshot.FixedSnapshotProof(*h.inspected)
		if err != nil {
			return empty, err
		}
		if err := h.currentAccount(); err != nil {
			return empty, err
		}
		if err := h.ensureMessageGuard(); err != nil {
			return empty, err
		}
		return proof, nil
	}
	if h.tail != nil {
		return empty, notaloneFailure("history_snapshot_unavailable")
	}
	inspection, err := h.inspect(ctx)
	if err != nil {
		return empty, err
	}
	if err := h.ensureMessageGuard(); err != nil {
		return empty, err
	}
	profile := notaloneReadProfile{SchemaShapeFingerprint: notaloneSnapshotShape(inspection.Tables), OpaqueStatusPolicy: "snapshot-opaque-v1"}
	snapshot, err := newNotaloneSnapshot(ctx, h.server, *h.selected, inspection, profile)
	if err != nil {
		return empty, err
	}
	proof, proofErr := snapshot.FixedSnapshotProof(inspection)
	closeErr := snapshot.Close()
	if proofErr != nil {
		return empty, proofErr
	}
	if closeErr != nil {
		return empty, notaloneFailure("history_snapshot_close_failed")
	}
	if err := h.currentAccount(); err != nil {
		return empty, err
	}
	if err := h.ensureMessageGuard(); err != nil {
		return empty, err
	}
	return proof, nil
}
