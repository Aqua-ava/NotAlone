package main

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/r266-tech/wx-cli/v2/internal/wcdb"
)

func notaloneSyntheticTailProfilePtr(tables []notaloneTableSchema) *notaloneReadProfile {
	profile := notaloneSyntheticFinalReadProfile(tables)
	profile.IncrementalTailVerified = true
	return &profile
}

func notaloneSyntheticTailCertification(program notaloneProgramVersion, tables []notaloneTableSchema) notaloneProfileCertification {
	return notaloneProfileCertification{
		Status: "supported", ProfileID: "synthetic-tail-profile", ProgramVersion: program.Version, Build: program.Build,
		DeclaredPrimaryKey: []string{"local_id"}, StatusSemantics: "synthetic-final", Continuity: "synthetic-source",
		SchemaShapeFingerprint: notaloneSnapshotShape(tables), Capabilities: notaloneSyntheticRuntimeCapabilities(),
		ReadProfile: notaloneSyntheticTailProfilePtr(tables),
	}
}

func TestNotAloneTailResumeDiffTombstoneReplayAndEmptyRecords(t *testing.T) {
	h := notaloneProtocolFixture(t, true)
	h.certify = notaloneSyntheticTailCertification
	writer, err := wcdb.OpenWithKeyMapWritable(filepath.Join(h.server.cfg.DBRoot, "db_storage/message/message_0.db"), h.server.cfg.Keys)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	if err = writer.Exec(`PRAGMA journal_mode=WAL;INSERT INTO "Msg_` + talkerHash("friend-a") + `"(local_id,server_id,local_type,real_sender_id,create_time,status,message_content) VALUES(2,0,1,1,1700000000,0,'删除正文');`); err != nil {
		t.Fatal(err)
	}

	request := notaloneHistoryRequest{Operation: "target", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-history-v1"}
	value, err := h.handle(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	target := value.(notaloneSnapshotTarget)
	request.Operation, request.Target = "page", target.Descriptor
	value, err = h.handle(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	historyPage := value.(notaloneSnapshotPage)
	if !historyPage.Exhausted || historyPage.ResumeCursor == nil || len(historyPage.Records) != 2 {
		t.Fatalf("可信合成历史终页应带resume cursor及两条基线记录: %#v", historyPage)
	}

	request.Operation, request.Cursor = "tail", *historyPage.ResumeCursor
	wrongTargetRequest := request
	wrongTargetRequest.Target = "other-target"
	if _, err = h.handle(context.Background(), wrongTargetRequest); err == nil || err.Error() != "history_cursor_invalid" {
		t.Fatalf("游标不得跨目标使用: %v", err)
	}
	value, err = h.handle(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	noChange := value.(notaloneTailPage)
	if !noChange.CaughtUp || len(noChange.Records) != 0 {
		t.Fatalf("无变化扫描页应为空并caught up: %#v", noChange)
	}
	encoded, err := json.Marshal(noChange)
	if err != nil || !strings.Contains(string(encoded), `"records":[]`) || strings.Contains(string(encoded), `"records":null`) {
		t.Fatalf("空扫描页必须编码为空数组: %s (%v)", encoded, err)
	}
	if len(h.tail.baseline) != 2 {
		t.Fatalf("baseline身份数量不正确: %d", len(h.tail.baseline))
	}
	for identity, entry := range h.tail.baseline {
		if identity.LocalID == "" || len(entry.Digest) != 64 {
			t.Fatalf("baseline只能保存身份和摘要: %#v %#v", identity, entry)
		}
	}
	replay, err := h.handle(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	replayedJSON, _ := json.Marshal(replay)
	if string(replayedJSON) != string(encoded) {
		t.Fatalf("相同cursor重试必须返回缓存页: %s != %s", replayedJSON, encoded)
	}

	if err = writer.Exec(`UPDATE "Msg_` + talkerHash("friend-a") + `" SET status=987,message_content='未知状态正文不得读取' WHERE local_id=1;DELETE FROM "Msg_` + talkerHash("friend-a") + `" WHERE local_id=2;INSERT INTO "Msg_` + talkerHash("friend-a") + `"(local_id,server_id,local_type,real_sender_id,create_time,status,message_content) VALUES(0,0,1,1,1700000000,0,'低ID迟到正文');`); err != nil {
		t.Fatal(err)
	}
	if err := h.messageGuard.Check(); err != nil {
		t.Fatalf("普通WAL提交不得丢失会话来源守卫: %v", err)
	}
	request.Cursor = noChange.CursorOut
	changed := []notaloneSnapshotRecord{}
	lastTailRequest := notaloneHistoryRequest{}
	for pageIndex := 0; pageIndex < 8; pageIndex++ {
		lastTailRequest = request
		value, err = h.handle(context.Background(), request)
		if err != nil {
			t.Fatal(err)
		}
		page := value.(notaloneTailPage)
		if len(page.Records) > 16 || page.CursorIn != request.Cursor || page.CursorOut == request.Cursor {
			t.Fatalf("tail页身份/预算不正确: %#v", page)
		}
		changed = append(changed, page.Records...)
		request.Cursor = page.CursorOut
		if page.CaughtUp {
			break
		}
		if pageIndex == 7 {
			t.Fatal("tail扫描在预期范围内未结束")
		}
	}
	if len(changed) != 3 {
		t.Fatalf("应输出新增、状态变化与删除墓碑三条记录，得到%d: %#v", len(changed), changed)
	}
	byID := map[string]notaloneSnapshotRecord{}
	for _, record := range changed {
		if record.LocalID == nil {
			t.Fatal("tail记录缺少local id")
		}
		byID[*record.LocalID] = record
	}
	if created := byID["0"]; created.Text == nil || *created.Text != "低ID迟到正文" {
		t.Fatalf("低local_id迟到新消息必须被完整重扫发现: %#v", created)
	}
	if updated := byID["1"]; updated.Text != nil || updated.StateAssurance != "unverified" || updated.Status == nil || *updated.Status != "987" {
		t.Fatalf("状态变化后正文必须继续受certified state gate保护: %#v", updated)
	}
	if tombstone := byID["2"]; tombstone.Text != nil || tombstone.StateAssurance != "unverified" || tombstone.Status != nil || tombstone.Sender != "unknown" {
		t.Fatalf("消失身份必须输出无正文未核验墓碑: %#v", tombstone)
	}
	verifiedAbsence := notaloneTailTombstone(notaloneTailIdentity{Partition: "partition", Table: "table", LocalID: "2"}, true)
	if verifiedAbsence.MessageState != "absent" || verifiedAbsence.StateAssurance != "verified" || verifiedAbsence.Text != nil || verifiedAbsence.OriginalType != "unknown" {
		t.Fatalf("仅获认证的完整重扫可输出verified absent终态：%#v", verifiedAbsence)
	}
	changedJSON, _ := json.Marshal(changed)
	if strings.Contains(string(changedJSON), "删除正文") || strings.Contains(string(changedJSON), "未知状态正文不得读取") {
		t.Fatalf("tail泄露删除或未知状态正文: %s", changedJSON)
	}
	if err := h.messageGuard.Close(); err != nil {
		t.Fatalf("close synthetic guard: %v", err)
	}
	if _, err := h.handle(context.Background(), lastTailRequest); err == nil || err.Error() != "history_source_changed" {
		t.Fatalf("guard loss后不得返回缓存页正文: %v", err)
	}
}

func TestNotAloneTailCursorIsSessionBoundAndTargetInstancesAreExact(t *testing.T) {
	left := notaloneSnapshotTarget{Protocol: "private-history-v1", Descriptor: "left", SourceGeneration: "generation", Partitions: []string{"p1", "p2"}, Tables: []notaloneSnapshotTable{{Partition: "p1", Instance: "i1"}, {Partition: "p2", Instance: "i2"}}}
	right := notaloneSnapshotTarget{Protocol: "private-history-v1", Descriptor: "right", SourceGeneration: "generation", Partitions: []string{"p2", "p1"}, Tables: []notaloneSnapshotTable{{Partition: "p2", Instance: "i2"}, {Partition: "p1", Instance: "i1"}}}
	if !notaloneSameSnapshotInstances(left, right) {
		t.Fatal("descriptor变化不应改变相同的稳定分区/实例集合")
	}
	right.Tables[1].Instance = "replacement"
	if notaloneSameSnapshotInstances(left, right) {
		t.Fatal("表实例变化必须使tail拒绝续读")
	}

	selected := notaloneResolved{Account: "owner", Conversation: "contact", SourceGeneration: "generation"}
	profile := notaloneReadProfile{SchemaShapeFingerprint: "shape", IncrementalTailVerified: true}
	baseline := map[notaloneTailIdentity]notaloneTailBaselineEntry{{Partition: "p1", Table: "i1", LocalID: "1"}: {Digest: strings.Repeat("a", 64)}}
	inspection := notaloneInspection{SourceGeneration: "generation", SchemaFingerprint: "schema", Tables: []notaloneTableSchema{}}
	if _, err := newNotaloneTailSession(left, selected, inspection, profile, baseline); err == nil || err.Error() != "history_schema_changed" {
		t.Fatalf("schema不相符的游标state必须拒绝: %v", err)
	}
}
