package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestNotAloneFixedSnapshotProofCoversEveryHeldPartition(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 2)
	if err := f.writers[1].Exec("DROP TABLE " + quoteIdent(f.table)); err != nil {
		t.Fatal(err)
	}
	session := newNotaloneHistorySession(f.server)
	session.selected = &f.selected
	var err error
	f.inspected, err = session.inspect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	profile := notaloneReadProfile{SchemaShapeFingerprint: notaloneSnapshotShape(f.inspected.Tables), OpaqueStatusPolicy: "snapshot-opaque-v1"}
	snapshot, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, profile)
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.Close()
	proof, err := snapshot.FixedSnapshotProof(f.inspected)
	if err != nil {
		t.Fatal(err)
	}
	if proof.Format != notaloneFixedSnapshotProofFormat || proof.Status != "verified" || proof.ScopeDigest != f.inspected.ScopeDigest ||
		proof.SourceGeneration != f.inspected.SourceGeneration || proof.SchemaFingerprint != f.inspected.SchemaFingerprint ||
		proof.ExpectedPartitionCount != 2 || proof.CompletedPartitionCount != 2 || !proof.NamespaceContinuity ||
		!proof.InstanceContinuity || !proof.SnapshotBarrier || proof.Scope != "single-fixed-snapshot" || proof.AuthorizesSubsequentRead {
		t.Fatalf("固定切面证明字段错误：%#v", proof)
	}
	if len(proof.Partitions) != 2 {
		t.Fatalf("应包括有表和无表分片：%#v", proof.Partitions)
	}
	present, absent := 0, 0
	for _, partition := range proof.Partitions {
		if partition.Partition == "" || partition.PreSample == "" || partition.PreSample != partition.PostSample ||
			!partition.ReaderPinned || !partition.SourceInstanceHeld {
			t.Fatalf("分片缺少固定快照/来源证据：%#v", partition)
		}
		if partition.TablePresent {
			if partition.Instance == nil || *partition.Instance == "" {
				t.Fatalf("有表分片缺少实例摘要：%#v", partition)
			}
			present++
		} else {
			if partition.Instance != nil {
				t.Fatalf("无表分片不能伪造表实例：%#v", partition)
			}
			absent++
		}
	}
	if present != 1 || absent != 1 {
		t.Fatalf("有表/无表分片覆盖错误：present=%d absent=%d", present, absent)
	}
	wrongSchema := f.inspected
	wrongSchema.SchemaFingerprint = "not-the-pinned-inspection"
	if _, err := snapshot.FixedSnapshotProof(wrongSchema); err == nil || err.Error() != "history_snapshot_proof_incomplete" {
		t.Fatalf("证明不得替换固定快照使用的结构摘要：%v", err)
	}
	missingPartition := f.inspected
	missingPartition.CheckedPartitions = append([]string(nil), f.inspected.CheckedPartitions[:1]...)
	if _, err := snapshot.FixedSnapshotProof(missingPartition); err == nil || err.Error() != "history_snapshot_proof_incomplete" {
		t.Fatalf("证明不得省略检查过的分片：%v", err)
	}
	encoded, err := json.Marshal(proof)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"合成正文", "source-secret", "message_content", f.server.cfg.DBRoot, "9007199254740993"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("证明泄露正文、路径或消息身份 %q", forbidden)
		}
	}
}

func TestNotAloneFixedSnapshotMetadataOperationHasSeparateConsentAndNoReadAuthorization(t *testing.T) {
	h := notaloneProtocolFixture(t, true)
	r := notaloneHistoryRequest{Operation: "verify-snapshot-metadata", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-snapshot-metadata-v1"}
	value, err := h.handle(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	proof, ok := value.(notaloneFixedSnapshotProof)
	if !ok || proof.Status != "verified" || proof.AuthorizesSubsequentRead || proof.Scope != "single-fixed-snapshot" || proof.ExpectedPartitionCount != 1 {
		t.Fatalf("固定切面metadata operation不能授予后续读取：%#v", value)
	}
	encoded, err := json.Marshal(proof)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"private-body-sentinel", "source-secret", h.server.cfg.DBRoot, "message_content", "localId", "serverId"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("固定切面证明泄露正文、路径或消息字段 %q", forbidden)
		}
	}
	r.Consent = "selected-history-v1"
	if _, err = h.handle(context.Background(), r); err == nil || err.Error() != "history_request_invalid" {
		t.Fatalf("metadata proof必须使用独立许可：%v", err)
	}
}
