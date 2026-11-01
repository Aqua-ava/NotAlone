package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strconv"
)

const notaloneTailIdentityLimit = 100_000

type notaloneTailIdentity struct {
	Partition string
	Table     string
	LocalID   string
}

// 基线只保留摘要和身份；消息正文仅在当前页面投影时短暂存在。
type notaloneTailBaselineEntry struct {
	Digest string
}

type notaloneTailPage struct {
	Target    string                   `json:"target"`
	CursorIn  string                   `json:"cursorIn"`
	CursorOut string                   `json:"cursorOut"`
	Records   []notaloneSnapshotRecord `json:"records"`
	CaughtUp  bool                     `json:"caughtUp"`
}

type notaloneTailSession struct {
	target            notaloneSnapshotTarget
	scopeDigest       string
	sourceGeneration  string
	schemaFingerprint string
	profile           notaloneReadProfile
	baseline          map[notaloneTailIdentity]notaloneTailBaselineEntry
	candidate         map[notaloneTailIdentity]notaloneTailBaselineEntry
	snapshot          *notaloneSnapshot
	snapshotCursor    string
	removed           []notaloneTailIdentity
	removedIndex      int
	deletionsReady    bool
	pendingCommit     bool
	expectedCursor    string
	lastInput         string
	lastResponse      *notaloneTailPage
	states            map[string]notaloneDeltaShardState
	nextStates        map[string]notaloneDeltaShardState
	checkpointToken   string
	changed           bool
}

func notaloneSnapshotRecordDigest(record notaloneSnapshotRecord) (notaloneTailIdentity, notaloneTailBaselineEntry, error) {
	if record.Partition == "" || record.Table == "" || record.LocalID == nil {
		return notaloneTailIdentity{}, notaloneTailBaselineEntry{}, notaloneFailure("history_identity_unverified")
	}
	localID, err := strconv.ParseInt(*record.LocalID, 10, 64)
	if err != nil || localID < 0 || strconv.FormatInt(localID, 10) != *record.LocalID {
		return notaloneTailIdentity{}, notaloneTailBaselineEntry{}, notaloneFailure("history_identity_unverified")
	}
	// 引用是同步时附带的补充投影，不改变旧checkpoint对消息身份与普通记录内容的摘要。
	record.Quote = nil
	record.QuoteErrorCode = ""
	encoded, err := json.Marshal(record)
	if err != nil {
		return notaloneTailIdentity{}, notaloneTailBaselineEntry{}, notaloneFailure("history_page_read_failed")
	}
	digest := sha256.Sum256(encoded)
	return notaloneTailIdentity{Partition: record.Partition, Table: record.Table, LocalID: *record.LocalID},
		notaloneTailBaselineEntry{Digest: hex.EncodeToString(digest[:])}, nil
}

// Page 持 snapshot.mu 调用本方法；身份键包含分区、表实例和 local_id。
func (n *notaloneSnapshot) recordIdentityDigests(shard *notaloneSnapshotShard, records []notaloneSnapshotRecord) error {
	if n.identityDigests == nil || shard == nil {
		return notaloneFailure("history_support_unverified")
	}
	for _, record := range records {
		identity, entry, err := notaloneSnapshotRecordDigest(record)
		if err != nil {
			return err
		}
		if identity.Partition != shard.partition || identity.Table != shard.instance {
			return notaloneFailure("history_identity_unverified")
		}
		if _, exists := n.identityDigests[identity]; exists {
			return notaloneFailure("history_identity_ambiguous")
		}
		if len(n.identityDigests) >= notaloneTailIdentityLimit {
			return notaloneFailure("history_tail_baseline_too_large")
		}
		n.identityDigests[identity] = entry
	}
	return nil
}

func newNotaloneTailSession(target notaloneSnapshotTarget, selected notaloneResolved, inspection notaloneInspection, profile notaloneReadProfile, baseline map[notaloneTailIdentity]notaloneTailBaselineEntry) (*notaloneTailSession, error) {
	if target.Descriptor == "" || target.SourceGeneration != selected.SourceGeneration || selected.Account == "" || selected.Conversation == "" || profile.SchemaShapeFingerprint == "" || !profile.IncrementalTailVerified || len(baseline) > notaloneTailIdentityLimit {
		return nil, notaloneFailure("history_tail_unsupported")
	}
	if inspection.SourceGeneration != selected.SourceGeneration || inspection.SchemaFingerprint == "" || profile.SchemaShapeFingerprint != notaloneSnapshotShape(inspection.Tables) {
		return nil, notaloneFailure("history_schema_changed")
	}
	cursor, err := notaloneSnapshotNonce()
	if err != nil {
		return nil, err
	}
	baselineCopy := make(map[notaloneTailIdentity]notaloneTailBaselineEntry, len(baseline))
	for identity, entry := range baseline {
		if identity.Partition == "" || identity.Table == "" || identity.LocalID == "" || len(entry.Digest) != 64 {
			return nil, notaloneFailure("history_identity_unverified")
		}
		baselineCopy[identity] = entry
	}
	cloneTarget := target
	cloneTarget.Partitions = append([]string(nil), target.Partitions...)
	cloneTarget.Tables = append([]notaloneSnapshotTable(nil), target.Tables...)
	cloneTarget.CheckedPartitions = append([]string(nil), target.CheckedPartitions...)
	return &notaloneTailSession{
		target: cloneTarget, scopeDigest: notaloneHash(selected.Account, selected.Conversation),
		sourceGeneration: selected.SourceGeneration, schemaFingerprint: inspection.SchemaFingerprint,
		profile: profile, baseline: baselineCopy, expectedCursor: cursor,
		checkpointToken: cursor,
	}, nil
}

func (h *notaloneHistorySession) resetTail() {
	if h.tail == nil {
		return
	}
	if h.tail.snapshot != nil {
		_ = h.tail.snapshot.Close()
	}
	h.tail = nil
}

func notaloneSameSnapshotInstances(expected, actual notaloneSnapshotTarget) bool {
	if expected.Protocol != actual.Protocol || expected.SourceGeneration != actual.SourceGeneration || len(expected.Partitions) != len(actual.Partitions) || len(expected.Tables) != len(actual.Tables) {
		return false
	}
	expectedPartitions := make(map[string]bool, len(expected.Partitions))
	for _, partition := range expected.Partitions {
		if partition == "" || expectedPartitions[partition] {
			return false
		}
		expectedPartitions[partition] = true
	}
	for _, partition := range actual.Partitions {
		if !expectedPartitions[partition] {
			return false
		}
		delete(expectedPartitions, partition)
	}
	if len(expectedPartitions) != 0 {
		return false
	}
	if len(actual.CheckedPartitions) == 0 && len(expected.CheckedPartitions) > 0 {
		return false
	}
	if len(expected.CheckedPartitions) > 0 && len(actual.CheckedPartitions) > 0 && !notaloneSameOrderedStrings(expected.CheckedPartitions, actual.CheckedPartitions) {
		return false
	}
	expectedTables := make(map[string]string, len(expected.Tables))
	for _, table := range expected.Tables {
		if table.Partition == "" || table.Instance == "" || expectedTables[table.Partition] != "" {
			return false
		}
		expectedTables[table.Partition] = table.Instance
	}
	for _, table := range actual.Tables {
		if table.Instance == "" || expectedTables[table.Partition] != table.Instance {
			return false
		}
		delete(expectedTables, table.Partition)
	}
	return len(expectedTables) == 0
}

func notaloneSameOrderedStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] == "" || left[index] != right[index] {
			return false
		}
	}
	return true
}

func notaloneTailIdentityLess(left, right notaloneTailIdentity) bool {
	if left.Partition != right.Partition {
		return left.Partition < right.Partition
	}
	if left.Table != right.Table {
		return left.Table < right.Table
	}
	leftID, leftErr := strconv.ParseInt(left.LocalID, 10, 64)
	rightID, rightErr := strconv.ParseInt(right.LocalID, 10, 64)
	if leftErr == nil && rightErr == nil {
		return leftID < rightID
	}
	return left.LocalID < right.LocalID
}

func notaloneTailTombstone(identity notaloneTailIdentity, verifiedAbsence bool) notaloneSnapshotRecord {
	localID := identity.LocalID
	record := notaloneSnapshotRecord{
		Partition: identity.Partition, Table: identity.Table, LocalID: &localID,
		Sender: "unknown", Kind: "other", OriginalType: "unknown", StateAssurance: "unverified",
	}
	if verifiedAbsence {
		record.MessageState = "absent"
		record.StateAssurance = "verified"
	}
	return record
}

func cloneNotaloneTailPage(page notaloneTailPage) notaloneTailPage {
	records := make([]notaloneSnapshotRecord, len(page.Records))
	copy(records, page.Records)
	page.Records = records
	return page
}

// 每次调用最多扫描一个16行页面；200页预算由上层SQLite服务控制。
func (h *notaloneHistorySession) tailPage(ctx context.Context, request notaloneHistoryRequest, support notaloneSupportReport, profile *notaloneReadProfile) (notaloneTailPage, error) {
	var empty notaloneTailPage
	if h == nil || h.selected == nil || h.inspected == nil || ctx == nil || ctx.Err() != nil || profile == nil {
		return empty, notaloneFailure("history_tail_unsupported")
	}
	if support.Status != "supported" || support.Capabilities["incrementalTail"] != "supported" || !profile.IncrementalTailVerified {
		return empty, notaloneFailure("history_tail_unsupported")
	}
	if h.tail == nil || request.Target != h.tail.target.Descriptor || h.tail.scopeDigest != notaloneHash(h.selected.Account, h.selected.Conversation) ||
		h.tail.sourceGeneration != h.selected.SourceGeneration || h.tail.schemaFingerprint != h.inspected.SchemaFingerprint {
		return empty, notaloneFailure("history_cursor_invalid")
	}
	tail := h.tail
	if err := h.currentAccount(); err != nil {
		h.resetTail()
		return empty, err
	}
	if err := h.ensureMessageGuard(); err != nil {
		h.resetTail()
		return empty, err
	}
	if request.Cursor == tail.lastInput && tail.lastResponse != nil {
		return cloneNotaloneTailPage(*tail.lastResponse), nil
	}
	if request.Cursor != tail.expectedCursor {
		return empty, notaloneFailure("history_cursor_invalid")
	}
	cursorOut, err := notaloneSnapshotNonce()
	if err != nil {
		return empty, err
	}
	if tail.pendingCommit {
		tail.baseline = tail.candidate
		tail.states = tail.nextStates
		tail.nextStates = nil
		tail.candidate = nil
		tail.pendingCommit = false
		tail.snapshotCursor = ""
		tail.removed = nil
		tail.removedIndex = 0
		tail.deletionsReady = false
		tail.changed = false
	}
	if tail.snapshot == nil && !tail.deletionsReady {
		snapshot, openErr := newNotaloneSnapshot(h.life, h.server, *h.selected, *h.inspected, *profile)
		if openErr != nil {
			h.resetTail()
			return empty, openErr
		}
		proof, proofErr := snapshot.FixedSnapshotProof(*h.inspected)
		if proofErr != nil || proof.Status != "verified" || proof.ExpectedPartitionCount == 0 || proof.ExpectedPartitionCount != proof.CompletedPartitionCount {
			_ = snapshot.Close()
			h.resetTail()
			if proofErr != nil {
				return empty, proofErr
			}
			return empty, notaloneFailure("history_snapshot_proof_incomplete")
		}
		if !notaloneSameSnapshotInstances(tail.target, snapshot.Target()) {
			_ = snapshot.Close()
			h.resetTail()
			return empty, notaloneFailure("history_source_changed")
		}
		if initErr := snapshot.initializeDelta(ctx, h.server, tail.states, tail.baseline, false, nil); initErr != nil {
			_ = snapshot.Close()
			return empty, initErr
		}
		tail.snapshot = snapshot
		tail.candidate = make(map[notaloneTailIdentity]notaloneTailBaselineEntry, len(tail.baseline))
		for identity, entry := range tail.baseline {
			tail.candidate[identity] = entry
		}
		for identity := range snapshot.deltaMissing {
			delete(tail.candidate, identity)
		}
	}
	records := make([]notaloneSnapshotRecord, 0, 16)
	scanDone := tail.deletionsReady
	if tail.snapshot != nil {
		inlineQuote := h.inlineQuoteContext(tail.snapshot, &support, profile)
		page, pageErr := tail.snapshot.Page(ctx, tail.snapshotCursor, inlineQuote)
		if pageErr != nil {
			h.resetTail()
			return empty, pageErr
		}
		for _, record := range page.Records {
			identity, entry, digestErr := notaloneSnapshotRecordDigest(record)
			if digestErr != nil {
				h.resetTail()
				return empty, digestErr
			}
			if _, duplicate := tail.candidate[identity]; duplicate {
				h.resetTail()
				return empty, notaloneFailure("history_identity_ambiguous")
			}
			tail.candidate[identity] = entry
			old, existed := tail.baseline[identity]
			if !existed || old.Digest != entry.Digest {
				records = append(records, record)
				tail.changed = true
			}
		}
		if page.Exhausted {
			tail.nextStates = tail.snapshot.deltaStates
			tail.snapshot = nil // Page 已关闭固定reader；候选仅保留身份与摘要。
			if len(tail.candidate) != len(tail.baseline) && len(tail.candidate) > notaloneTailIdentityLimit {
				h.resetTail()
				return empty, notaloneFailure("history_tail_baseline_too_large")
			}
			tail.removed = make([]notaloneTailIdentity, 0)
			for identity := range tail.baseline {
				if _, found := tail.candidate[identity]; !found {
					tail.removed = append(tail.removed, identity)
				}
			}
			sort.Slice(tail.removed, func(i, j int) bool { return notaloneTailIdentityLess(tail.removed[i], tail.removed[j]) })
			tail.deletionsReady = true
			scanDone = true
		} else {
			if page.CursorOut == nil || *page.CursorOut == tail.snapshotCursor {
				h.resetTail()
				return empty, notaloneFailure("history_cursor_invalid")
			}
			tail.snapshotCursor = *page.CursorOut
			scanDone = false
		}
	}
	for scanDone && len(records) < 16 && tail.removedIndex < len(tail.removed) {
		tail.changed = true
		records = append(records, notaloneTailTombstone(tail.removed[tail.removedIndex], tail.profile.VerifiedTerminalAbsence))
		tail.removedIndex++
	}
	caughtUp := scanDone && tail.removedIndex == len(tail.removed)
	if caughtUp {
		if !tail.changed && tail.checkpointToken != "" {
			cursorOut = tail.checkpointToken + "." + cursorOut
		} else {
			if saveErr := h.saveCheckpoint(support, *profile, tail.target, cursorOut, tail.candidate, tail.nextStates); saveErr != nil {
				h.resetTail()
				return empty, saveErr
			}
			tail.checkpointToken = cursorOut
		}
		tail.pendingCommit = true
	}
	if !caughtUp && tail.checkpointToken != "" {
		cursorOut = tail.checkpointToken + "." + cursorOut
	}
	result := notaloneTailPage{Target: tail.target.Descriptor, CursorIn: request.Cursor, CursorOut: cursorOut, Records: records, CaughtUp: caughtUp}
	tail.lastInput = request.Cursor
	tail.lastResponse = &result
	tail.expectedCursor = cursorOut
	if err := h.ensureMessageGuard(); err != nil {
		h.resetTail()
		return empty, err
	}
	return cloneNotaloneTailPage(result), nil
}
