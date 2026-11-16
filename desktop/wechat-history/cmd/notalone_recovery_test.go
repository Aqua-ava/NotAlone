package main

import (
	"context"
	"encoding/json"
	"github.com/r266-tech/wx-cli/v2/internal/wcdb"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNotAloneRecoverTargetContinuesAfterStoredLocalID(t *testing.T) {
	h, _, _, target := notalonePartialHistoryFixture(t, 48)
	payload, _ := json.Marshal(map[string]any{"op": "recover-target", "account": h.selected.Account, "conversation": h.selected.Conversation, "consent": "selected-history-v1", "previousTarget": target, "positions": []any{map[string]any{"partition": target.Tables[0].Partition, "table": target.Tables[0].Instance, "maxLocalId": "32", "anchorLocalIds": []string{"31", "32"}}}})
	var request notaloneHistoryRequest
	if err := json.Unmarshal(payload, &request); err != nil {
		t.Fatal(err)
	}
	value, err := h.handle(context.Background(), request)
	if err != nil {
		t.Fatalf("相同物理来源应允许按已存水位恢复：%v", err)
	}
	encoded, _ := json.Marshal(value)
	var recovered struct {
		Target  notaloneSnapshotTarget   `json:"target"`
		Cursor  string                   `json:"cursor"`
		Anchors []notaloneSnapshotRecord `json:"anchors"`
	}
	if err = json.Unmarshal(encoded, &recovered); err != nil {
		t.Fatal(err)
	}
	if recovered.Cursor == "" || len(recovered.Anchors) != 2 || recovered.Anchors[0].LocalID == nil || *recovered.Anchors[0].LocalID != "31" {
		t.Fatal("恢复只返回指定锚点与原生签发恢复点")
	}
	page, _ := notalonePartialHistoryPage(t, h, recovered.Target, "", false)
	if len(page.Records) != 16 || page.Records[0].LocalID == nil || *page.Records[0].LocalID != "33" || !page.Exhausted {
		t.Fatal("应仅补读33至48，不能全量重读")
	}
}

func TestNotAloneRecoveryCheckpointSurvivesRestartWithoutOldBodyReplay(t *testing.T) {
	h, _, _, target := notalonePartialHistoryFixture(t, 64)
	position := notaloneRecoveryPosition{Partition: target.Tables[0].Partition, Table: target.Tables[0].Instance, MaxLocalID: "32", AnchorLocalIDs: []string{"31", "32"}}
	value, err := h.handle(context.Background(), notaloneHistoryRequest{Operation: "recover-target", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-history-v1", PreviousTarget: &target, Positions: []notaloneRecoveryPosition{position}})
	if err != nil {
		t.Fatal(err)
	}
	recovered := value.(notaloneRecoveryResult)
	h, target = notaloneResumePartialHistory(t, h, recovered.Target, recovered.Cursor, true)
	page, checkpoint := notalonePartialHistoryPage(t, h, target, "", true)
	if len(page.Records) != 16 || *page.Records[0].LocalID != "33" {
		t.Fatal("原生恢复点重启后不得重读已存1至32")
	}
	h, target = notaloneResumePartialHistory(t, h, target, checkpoint, true)
	page, _ = notalonePartialHistoryPage(t, h, target, "", false)
	if len(page.Records) != 16 || *page.Records[0].LocalID != "49" || !page.Exhausted {
		t.Fatal("已接纳恢复片段也不得再次投影")
	}
}

func TestNotAloneRecoverTargetRejectsChangedSourceAndInvalidPositions(t *testing.T) {
	for _, name := range []string{"generation", "partition", "instance", "file-set", "duplicate-position", "over-budget-anchor", "anchor-after-watermark"} {
		t.Run(name, func(t *testing.T) {
			h, _, _, target := notalonePartialHistoryFixture(t, 48)
			previous := target
			previous.Tables = append([]notaloneSnapshotTable(nil), target.Tables...)
			previous.CheckedPartitions = append([]string(nil), target.CheckedPartitions...)
			positions := []notaloneRecoveryPosition{{Partition: target.Tables[0].Partition, Table: target.Tables[0].Instance, MaxLocalID: "32", AnchorLocalIDs: []string{"32"}}}
			switch name {
			case "generation":
				previous.SourceGeneration = "changed"
			case "partition":
				previous.Tables[0].Partition = "changed"
			case "instance":
				previous.Tables[0].Instance = "changed"
			case "file-set":
				previous.CheckedPartitions = append(previous.CheckedPartitions, "changed")
			case "duplicate-position":
				positions = append(positions, positions[0])
			case "over-budget-anchor":
				positions[0].AnchorLocalIDs = []string{"1", "2", "3", "4", "5", "6", "7", "8", "9"}
			case "anchor-after-watermark":
				positions[0].AnchorLocalIDs = []string{"33"}
			}
			_, err := h.handle(context.Background(), notaloneHistoryRequest{Operation: "recover-target", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-history-v1", PreviousTarget: &previous, Positions: positions})
			if err == nil {
				t.Fatal("来源变化或不合法恢复范围不得签发恢复点")
			}
		})
	}
}

func TestNotAloneRecoveryPhysicalMetadataOrderingDoesNotChangeSource(t *testing.T) {
	current := notaloneSnapshotTarget{Protocol: "private-history-v1", SourceGeneration: "same", Partitions: []string{"partition-a", "partition-b"}, CheckedPartitions: []string{"partition-b", "partition-a"}, Tables: []notaloneSnapshotTable{{Partition: "partition-a", Instance: "table-a"}, {Partition: "partition-b", Instance: "table-b"}}}
	previous := current
	previous.CheckedPartitions = []string{"partition-a", "partition-b"}
	_, err := notaloneRecoveryPositions(previous, current, []notaloneRecoveryPosition{{Partition: "partition-a", Table: "table-a", MaxLocalID: "0"}, {Partition: "partition-b", Table: "table-b", MaxLocalID: "0"}})
	if err != nil {
		t.Fatal("同一物理元数据集合的序列化顺序不能造成来源变化")
	}
}

func TestNotAloneNormalRecoveryDeclaresVerifiedTableGrowth(t *testing.T) {
	h, _, _, _ := notalonePartialHistoryFixture(t, 32)
	value, err := h.handle(context.Background(), notaloneHistoryRequest{Operation: "support", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-schema-v1"})
	if err != nil {
		t.Fatal(err)
	}
	report := value.(notaloneSupportReport)
	if report.Capabilities["partitionGrowth"] != "supported" {
		t.Fatal("正常已认证来源必须声明已实现的同一检查文件内表增长恢复，不能只让空目标声明")
	}
}

func TestNotAloneRecoverKnownFileNewTableReadsOnlyNewTable(t *testing.T) {
	h := notaloneProtocolFixture(t, true)
	h.certify = notaloneSyntheticTailCertification
	h.checkpointDirectory = t.TempDir()
	if err := os.Chmod(h.checkpointDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	table := "Msg_" + talkerHash(h.selected.Conversation)
	notaloneTestDB(t, h.server.cfg.DBRoot, h.server.cfg, "message", "message_1.db", "CREATE TABLE Name2Id(user_name TEXT);INSERT INTO Name2Id(rowid,user_name) VALUES(1,'friend-a'),(2,'synthetic-owner');", strings.Repeat("66", 16))
	configBytes, _ := json.Marshal(h.server.cfg)
	if err := os.WriteFile(os.Getenv("WECHAT_CLI_CONFIG"), configBytes, 0600); err != nil {
		t.Fatal(err)
	}
	writer, err := wcdb.OpenWithKeyMapWritable(filepath.Join(h.server.cfg.DBRoot, "db_storage/message/message_1.db"), h.server.cfg.Keys)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { writer.Close() })
	original, err := wcdb.OpenWithKeyMapWritable(filepath.Join(h.server.cfg.DBRoot, "db_storage/message/message_0.db"), h.server.cfg.Keys)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { original.Close() })
	// 只读来源不创建 SHM；合成写者须先实际读取 WAL 数据库以初始化旁车。
	if err = writer.Exec("PRAGMA journal_mode=WAL;PRAGMA user_version=1"); err != nil {
		t.Fatal(err)
	}
	if err = original.Exec("PRAGMA journal_mode=WAL;PRAGMA user_version=1"); err != nil {
		t.Fatal(err)
	}
	value, err := h.handle(context.Background(), notaloneHistoryRequest{Operation: "target", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-history-v1"})
	if err != nil {
		t.Fatal(err)
	}
	old := value.(notaloneSnapshotTarget)
	if len(old.Tables) != 1 || len(old.CheckedPartitions) != 2 {
		t.Fatal("合成前提应为两个已检查文件、一个目标表")
	}
	rows, err := original.QueryBounded(context.Background(), 1, "SELECT sql FROM sqlite_master WHERE name=?", table)
	if err != nil {
		t.Fatal(err)
	}
	if err = writer.Exec(rowString(rows[0], "sql") + ";INSERT INTO " + quoteIdent(table) + "(local_id,server_id,local_type,real_sender_id,create_time,status,message_content) VALUES(1,0,1,1,1700000000,0,'合成新表消息')"); err != nil {
		t.Fatal(err)
	}
	value, err = h.handle(context.Background(), notaloneHistoryRequest{Operation: "recover-target", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-history-v1", PreviousTarget: &old, Positions: []notaloneRecoveryPosition{{Partition: old.Tables[0].Partition, Table: old.Tables[0].Instance, MaxLocalID: "1", AnchorLocalIDs: []string{"1"}}}})
	if err != nil {
		t.Fatalf("已检查文件新增同结构表应增量恢复：%v", err)
	}
	recovered := value.(notaloneRecoveryResult)
	if len(recovered.Target.Tables) != 2 || len(recovered.Anchors) != 1 {
		t.Fatal("恢复目标必须包含新表且只核对旧表锚点")
	}
	page, _ := notalonePartialHistoryPage(t, h, recovered.Target, "", false)
	if len(page.Records) != 1 || page.Records[0].Partition == old.Tables[0].Partition || page.Records[0].LocalID == nil || *page.Records[0].LocalID != "1" {
		t.Fatal("只补读新增表，不重读旧表历史")
	}
}
