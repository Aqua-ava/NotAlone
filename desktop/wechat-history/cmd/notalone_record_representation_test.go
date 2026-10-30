package main

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/r266-tech/wx-cli/v2/internal/wcdb"
)

func TestNotAloneSnapshotReadsObservedNormalHistoryText(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 1)
	if err := f.writers[0].Exec(`DELETE FROM ` + quoteIdent(f.table) + `;
		INSERT INTO ` + quoteIdent(f.table) + `(local_id,server_id,local_type,real_sender_id,status,message_content) VALUES
		(1,101,1,1,2,'合成本人正常历史二'),(2,102,1,1,3,'合成本人正常历史三'),
		(3,103,1,2,3,'合成对方正常历史三'),(4,104,1,2,4,'合成对方正常历史四'),
		(5,0,1,1,3,'未分配本人正文'),(6,0,1,2,4,'未分配对方正文'),
		(7,107,4294967297,2,4,'高位类型正文');`); err != nil {
		t.Fatal(err)
	}
	profile := notaloneSyntheticReadProfile(f.inspected.Tables, notalone40629387ObservedStatusRules()...)
	snapshot, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, profile)
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.Close()
	page, err := snapshot.Page(context.Background(), "")
	if err != nil || !page.Exhausted || len(page.Records) != 7 {
		t.Fatalf("正常历史页不完整：%v", err)
	}
	want := map[string]string{"1": "合成本人正常历史二", "2": "合成本人正常历史三", "3": "合成对方正常历史三", "4": "合成对方正常历史四"}
	for _, record := range page.Records {
		body, eligible := want[*record.LocalID]
		if eligible {
			state := "sent"
			if *record.LocalID == "3" || *record.LocalID == "4" {
				state = "received"
			}
			if record.Text == nil || *record.Text != body || record.StateAssurance != "verified" || record.MessageState != state || record.MetadataOnly {
				t.Fatalf("已核验正常文字须完整保留正文和方向：%#v", record)
			}
		} else if record.Text != nil || record.StateAssurance != "unverified" || record.MessageState != "" || record.MetadataOnly {
			t.Fatalf("无服务端身份或未知高位文字不得放行：%#v", record)
		}
	}
}

func TestNotAloneHistoryProtocolSeparatesNormalTextAndMetadataOnly(t *testing.T) {
	h := notaloneProtocolFixture(t, true)
	certify := h.certify
	h.certify = func(program notaloneProgramVersion, tables []notaloneTableSchema) notaloneProfileCertification {
		result := certify(program, tables)
		profile := notaloneSyntheticReadProfile(tables, notalone40629387ObservedStatusRules()...)
		result.ReadProfile = &profile
		return result
	}
	writer, err := wcdb.OpenWithKeyMapWritable(filepath.Join(h.server.cfg.DBRoot, "db_storage/message/message_0.db"), h.server.cfg.Keys)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	table := quoteIdent("Msg_" + talkerHash("friend-a"))
	if err := writer.Exec(`DELETE FROM ` + table + `;
		INSERT INTO ` + table + `(local_id,server_id,local_type,real_sender_id,status,message_content,source) VALUES
		(1,101,1,2,2,'合成本人历史二','source-xml-secret'),(2,102,1,2,3,'合成本人历史三','source-xml-secret'),
		(3,103,1,1,3,'合成对方历史三','source-xml-secret'),(4,104,1,1,4,'合成对方历史四','source-xml-secret'),
		(5,105,10000,3,4,'不得读取系统载荷','source-xml-secret'),(6,106,244813135921,1,4,'不得读取引用载荷','source-xml-secret');`); err != nil {
		t.Fatal(err)
	}
	r := notaloneHistoryRequest{Operation: "target", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-history-v1"}
	value, err := h.handle(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	r.Operation, r.Target = "page", value.(notaloneSnapshotTarget).Descriptor
	value, err = h.handle(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	page := value.(notaloneSnapshotPage)
	if !page.Exhausted || len(page.Records) != 6 {
		t.Fatalf("正式协议未返回完整混合页：%#v", page)
	}
	for index, record := range page.Records {
		if index < 4 {
			if record.Text == nil || record.StateAssurance != "verified" || record.MetadataOnly || record.MessageState == "" {
				t.Fatalf("正式协议遗漏已核验正常文字：%#v", record)
			}
		} else if record.Text != nil || !record.MetadataOnly || record.StateAssurance != "unverified" || record.MessageState != "" {
			t.Fatalf("正式协议未按无正文元数据输出系统或引用记录：%#v", record)
		}
	}
	encoded, err := json.Marshal(page)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "不得读取") || strings.Contains(string(encoded), "source-xml-secret") || strings.Contains(string(encoded), `"recalled"`) {
		t.Fatal("正式协议泄露非文字载荷或误报撤回")
	}
}

func TestNotAloneSnapshotKeepsNonTextMetadataWithoutDeliveryClaims(t *testing.T) {
	for _, trusted := range []bool{true, false} {
		t.Run(map[bool]string{true: "trusted-history", false: "opaque-metadata"}[trusted], func(t *testing.T) {
			f := newNotaloneSnapshotFixture(t, 1)
			if err := f.writers[0].Exec(`DELETE FROM ` + quoteIdent(f.table) + `;
				INSERT INTO ` + quoteIdent(f.table) + `(local_id,server_id,local_type,real_sender_id,status,message_content,source) VALUES
				(1,0,3,1,99,zeroblob(1048576),'系统和媒体来源不可读取'),
				(2,0,34,2,99,'语音载荷不可读取','系统和媒体来源不可读取'),
				(3,0,43,1,99,'视频载荷不可读取',NULL),(4,0,62,2,99,'短视频载荷不可读取',NULL),
				(5,0,47,2,99,'表情载荷不可读取',NULL),(6,0,25769803825,1,99,'文件载荷不可读取',NULL),
				(7,0,244813135921,2,99,'引用XML不可读取',NULL),(8,0,21474836529,2,99,'链接XML不可读取',NULL),
				(9,0,10000,1,4,'系统通知不可读取',NULL),(10,0,10000,2,4,'系统通知不可读取',NULL),
				(11,0,10000,3,4,'系统通知不可读取',NULL),(12,0,9999,3,99,'未知非文字不可读取',NULL),
				(13,0,49,2,99,'应用XML不可读取',NULL),(14,0,NULL,2,4,'未知类型不可读取',NULL),
				(15,115,4294967297,2,4,'高位文字不可读取',NULL),(16,0,-1,2,4,'非法类型不可读取',NULL);`); err != nil {
				t.Fatal(err)
			}
			profile := notaloneReadProfile{SchemaShapeFingerprint: notaloneSnapshotShape(f.inspected.Tables), OpaqueStatusPolicy: "snapshot-opaque-v1"}
			if trusted {
				profile = notaloneSyntheticReadProfile(f.inspected.Tables, notalone40629387ObservedStatusRules()...)
			}
			snapshot, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, profile)
			if err != nil {
				t.Fatal(err)
			}
			defer snapshot.Close()
			page, err := snapshot.Page(context.Background(), "")
			if err != nil || !page.Exhausted || len(page.Records) != 16 {
				t.Fatalf("非文字元数据页不完整：%v", err)
			}
			encoded, err := json.Marshal(page)
			if err != nil {
				t.Fatal(err)
			}
			var wire struct {
				Records []map[string]any `json:"records"`
			}
			if err := json.Unmarshal(encoded, &wire); err != nil {
				t.Fatal(err)
			}
			wantKinds := []string{"image", "voice", "video", "video", "sticker", "file", "other", "other", "other", "other", "other", "other", "other", "other", "text", "other"}
			for index, record := range page.Records {
				metadataOnly, present := wire.Records[index]["metadataOnly"]
				wantMetadata := trusted && index < 13
				if present != wantMetadata || present && metadataOnly != true || record.Kind != wantKinds[index] || record.Text != nil || record.MessageState != "" || record.StateAssurance != "unverified" || record.Status == nil {
					t.Fatalf("无正文观察不得声称送达或撤回，记录%d：%#v metadataOnly=%v", index+1, record, metadataOnly)
				}
			}
			if strings.Contains(string(encoded), "不可读取") || strings.Contains(string(encoded), "source") {
				t.Fatal("非文字页夹带载荷或XML来源")
			}
		})
	}
}
