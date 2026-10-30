package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func notaloneSyntheticBoundarySnapshot(t *testing.T, shards int, semantics bool) (*notaloneSnapshotFixture, *notaloneSnapshot) {
	t.Helper()
	f := newNotaloneSnapshotFixture(t, shards)
	profile := notaloneReadProfile{
		SchemaShapeFingerprint:    notaloneSnapshotShape(f.inspected.Tables),
		OpaqueStatusPolicy:        "snapshot-opaque-v1",
		BoundarySemanticsVerified: semantics,
	}
	snapshot, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, profile)
	if err != nil {
		t.Fatalf("建立合成固定快照：%v", err)
	}
	t.Cleanup(func() { _ = snapshot.Close() })
	return &f, snapshot
}

func TestNotAloneBoundarySnapshotReturnsFullExactIDsWithoutMessageBody(t *testing.T) {
	f, snapshot := notaloneSyntheticBoundarySnapshot(t, 2, true)
	report, err := notaloneBoundaryMembers(context.Background(), snapshot, f.inspected.SchemaFingerprint)
	if err != nil {
		t.Fatal(err)
	}
	if report.Format != notaloneBoundaryFormat || report.ScopeDigest != notaloneHash(f.selected.Account, f.selected.Conversation) || report.SourceGeneration != f.selected.SourceGeneration {
		t.Fatalf("boundary scope不符：%#v", report)
	}
	if report.SchemaFingerprint != f.inspected.SchemaFingerprint || report.BoundaryToken == "" || report.ObservedAt == "" {
		t.Fatalf("boundary报告缺少身份/令牌/时间：%#v", report)
	}
	if len(report.Members) != 2 || len(report.Partitions) != 2 || len(report.Target.Tables) != 2 {
		t.Fatalf("应完整列出两分片成员：members=%d partitions=%d target=%#v", len(report.Members), len(report.Partitions), report.Target)
	}
	for _, member := range report.Members {
		if member.LocalID != "9007199254740993" || member.Table == "" || member.Partition == "" {
			t.Fatalf("local_id精确保留：%#v", member)
		}
	}
	for _, evidence := range report.Partitions {
		if evidence.Instance == "" || evidence.PreSample == "" || evidence.PostSample == "" || evidence.PreSample != evidence.PostSample || !evidence.ReaderCompleted || evidence.MemberCount != 1 {
			t.Fatalf("partition缺少真实获取窗口证据：%#v", evidence)
		}
	}
	if !report.NamespaceContinuity || !report.InstanceContinuity {
		t.Fatalf("合成固定命名空间与实例连续：%#v", report)
	}
	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"合成正文", "source-secret", "message_content", "local_type", "server_id"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("boundary响应夹带正文或非身份列 %q", forbidden)
		}
	}
}

func TestNotAloneBoundarySnapshotRequiresExplicitSyntheticCapability(t *testing.T) {
	f, snapshot := notaloneSyntheticBoundarySnapshot(t, 1, false)
	if _, err := notaloneBoundaryMembers(context.Background(), snapshot, f.inspected.SchemaFingerprint); err == nil || err.Error() != "history_boundary_support_unverified" {
		t.Fatalf("默认关闭的boundary capability必须拒绝：%v", err)
	}
}

func TestNotAloneBoundaryRequestRejectsUnverifiedReportWithEnabledFlag(t *testing.T) {
	h := notaloneProtocolFixture(t, true)
	h.certify = func(program notaloneProgramVersion, tables []notaloneTableSchema) notaloneProfileCertification {
		profile := notaloneSyntheticFinalReadProfile(tables)
		profile.BoundarySemanticsVerified = true
		return notaloneProfileCertification{Status: "unverified", ProfileID: "synthetic-unverified-boundary", ProgramVersion: program.Version, Build: program.Build,
			DeclaredPrimaryKey: []string{"local_id"}, StatusSemantics: "synthetic-final", Continuity: "synthetic-source",
			Capabilities: map[string]string{"programVersion": "supported", "exactSchema": "supported", "declaredLocalKey": "supported"}, ReadProfile: &profile}
	}
	if _, err := h.handle(context.Background(), notaloneHistoryRequest{Operation: "support", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-schema-v1"}); err != nil {
		t.Fatal(err)
	}
	_, err := h.handle(context.Background(), notaloneHistoryRequest{Operation: "boundary-snapshot", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: notaloneBoundaryConsent})
	if err == nil || err.Error() != "history_boundary_support_unverified" {
		t.Fatalf("未认证报告不能借profile标志读取边界：%v", err)
	}
}

func TestNotAloneBoundarySnapshotCancellationReachesSnapshotAndReader(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 1)
	profile := notaloneReadProfile{
		SchemaShapeFingerprint:    notaloneSnapshotShape(f.inspected.Tables),
		OpaqueStatusPolicy:        "snapshot-opaque-v1",
		BoundarySemanticsVerified: true,
	}
	request, cancelRequest := context.WithCancel(context.Background())
	attempt, release := notaloneBoundaryAttemptContext(request, context.Background())
	defer release()
	cancelRequest()
	if _, err := newNotaloneSnapshot(attempt, f.server, f.selected, f.inspected, profile); err == nil || err.Error() != "history_snapshot_cancelled" {
		t.Fatalf("请求取消必须传入固定reader创建：%v", err)
	}
	request2 := context.Background()
	sessionLife2, cancelSession2 := context.WithCancel(context.Background())
	attempt2, release2 := notaloneBoundaryAttemptContext(request2, sessionLife2)
	defer release2()
	cancelSession2()
	<-attempt2.Done()
	if _, err := newNotaloneSnapshot(attempt2, f.server, f.selected, f.inspected, profile); err == nil || err.Error() != "history_snapshot_cancelled" {
		t.Fatalf("会话取消必须传入固定reader创建：%v", err)
	}
	snapshot, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, profile)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = snapshot.Close() })
	canceledRead, cancelRead := context.WithCancel(context.Background())
	cancelRead()
	if _, err := notaloneBoundaryMembers(canceledRead, snapshot, f.inspected.SchemaFingerprint); err == nil || err.Error() != "history_snapshot_cancelled" {
		t.Fatalf("请求取消必须中断boundary枚举reader：%v", err)
	}
}

func TestNotAloneBoundarySnapshotReportsEmptyPartitionAsCompleted(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 2)
	if err := f.writers[0].Exec("DELETE FROM " + quoteIdent(f.table)); err != nil {
		t.Fatal(err)
	}
	profile := notaloneReadProfile{
		SchemaShapeFingerprint:    notaloneSnapshotShape(f.inspected.Tables),
		OpaqueStatusPolicy:        "snapshot-opaque-v1",
		BoundarySemanticsVerified: true,
	}
	snapshot, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, profile)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = snapshot.Close() })
	report, err := notaloneBoundaryMembers(context.Background(), snapshot, f.inspected.SchemaFingerprint)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Members) != 1 || len(report.Partitions) != 2 {
		t.Fatalf("应包含一个非空分片成员和两个完成分片：%#v", report)
	}
	zeroCount, nonzeroCount := 0, 0
	for _, partition := range report.Partitions {
		if !partition.ReaderCompleted {
			t.Fatalf("空分片也必须完成枚举：%#v", partition)
		}
		if partition.MemberCount == 0 {
			zeroCount++
		} else if partition.MemberCount == 1 {
			nonzeroCount++
		} else {
			t.Fatalf("分片成员计数不符：%#v", partition)
		}
	}
	if zeroCount != 1 || nonzeroCount != 1 {
		t.Fatalf("空/非空分片计数不符：zero=%d nonzero=%d evidence=%#v", zeroCount, nonzeroCount, report.Partitions)
	}
}

func TestNotAloneBoundarySnapshotAllowsExactlyOneHundredThousandMembers(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 1)
	if err := f.writers[0].Exec("WITH RECURSIVE seq(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM seq WHERE id<99999) INSERT INTO " + quoteIdent(f.table) + "(local_id,message_content) SELECT id,'BODY_SENTINEL' FROM seq"); err != nil {
		t.Fatal(err)
	}
	profile := notaloneReadProfile{
		SchemaShapeFingerprint:    notaloneSnapshotShape(f.inspected.Tables),
		OpaqueStatusPolicy:        "snapshot-opaque-v1",
		BoundarySemanticsVerified: true,
	}
	snapshot, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, profile)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = snapshot.Close() })
	report, err := notaloneBoundaryMembers(context.Background(), snapshot, f.inspected.SchemaFingerprint)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Members) != notaloneBoundaryMemberLimit || len(report.Partitions) != 1 || report.Partitions[0].MemberCount != notaloneBoundaryMemberLimit {
		t.Fatalf("100,000个成员应完整保留：members=%d partitions=%#v", len(report.Members), report.Partitions)
	}
}

func TestNotAloneBoundarySnapshotCapsMembershipAtOneHundredThousand(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 1)
	if err := f.writers[0].Exec("WITH RECURSIVE seq(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM seq WHERE id<100001) INSERT INTO " + quoteIdent(f.table) + "(local_id,message_content) SELECT id,'BODY_SENTINEL' FROM seq"); err != nil {
		t.Fatal(err)
	}
	profile := notaloneReadProfile{
		SchemaShapeFingerprint:    notaloneSnapshotShape(f.inspected.Tables),
		OpaqueStatusPolicy:        "snapshot-opaque-v1",
		BoundarySemanticsVerified: true,
	}
	snapshot, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, profile)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = snapshot.Close() })
	if _, err := notaloneBoundaryMembers(context.Background(), snapshot, f.inspected.SchemaFingerprint); err == nil || err.Error() != "history_boundary_member_limit" {
		t.Fatalf("超过10万身份必须拒绝且不返回截断候选：%v", err)
	}
}
