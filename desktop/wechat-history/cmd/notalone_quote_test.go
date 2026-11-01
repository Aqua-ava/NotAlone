package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
	"github.com/r266-tech/wx-cli/v2/internal/wcdb"
)

const (
	notaloneQuoteTestRawType      = int64(244813135921)
	notaloneQuoteTestLocalID      = int64(9007199254740993)
	notaloneQuoteTestServerID     = int64(9223372036854775806)
	notaloneQuoteTestXMLByteLimit = 256 << 10
)

type notaloneQuoteTestRow struct {
	rawType     int64
	senderID    int64
	status      int64
	serverID    int64
	setServerID bool
	createAt    any
	content     []byte
	typeCode    int64
}

func notaloneQuoteTestXML(reply, referenceType, referenceServerID, referenceAuthor, referenceDisplay, referenceContent string) []byte {
	return []byte(fmt.Sprintf(`<msg><appmsg><title>%s</title><refermsg><type>%s</type><svrid>%s</svrid><fromusr>%s</fromusr><displayname>%s</displayname><content>%s</content></refermsg></appmsg></msg>`, reply, referenceType, referenceServerID, referenceAuthor, referenceDisplay, referenceContent))
}

func notaloneQuoteProtocolFixture(t *testing.T, row notaloneQuoteTestRow) (*notaloneHistorySession, notaloneHistoryRequest) {
	t.Helper()
	if os.Getenv("NOTALONE_TEST_WCDB") == "" {
		t.Skip("需要显式合成WCDB制品")
	}
	server := notaloneHistoryFixture(t)
	table := `"Msg_` + talkerHash("friend-a") + `"`
	dbPath := filepath.Join(server.cfg.DBRoot, "db_storage", "message", "message_0.db")
	db, err := wcdb.OpenWithKeyMapWritable(dbPath, server.cfg.Keys)
	if err != nil {
		t.Fatal(err)
	}
	createAtSQL := "NULL"
	if value, ok := row.createAt.(int64); ok {
		createAtSQL = fmt.Sprint(value)
	}
	serverID := notaloneQuoteTestServerID
	if row.setServerID {
		serverID = row.serverID
	}
	query := fmt.Sprintf(`CREATE TABLE Name2Id(user_name TEXT);
INSERT INTO Name2Id(rowid,user_name) VALUES(1,'synthetic-owner'),(2,'friend-a'),(3,'other-person');
ALTER TABLE %s ADD COLUMN WCDB_CT_message_content INTEGER NOT NULL DEFAULT 0;
UPDATE %s SET local_id=%d,server_id=%d,local_type=%d,real_sender_id=%d,create_time=%s,status=%d,message_content=x'%s',WCDB_CT_message_content=%d WHERE local_id=1;`,
		table, table, notaloneQuoteTestLocalID, serverID, row.rawType, row.senderID, createAtSQL, row.status, hex.EncodeToString(row.content), row.typeCode)
	if err = db.Exec(query); err != nil {
		db.Close()
		t.Fatal(err)
	}
	db.Close()

	h := newNotaloneHistorySession(server)
	h.sourceProcess = func(context.Context) (notaloneProcessIdentity, error) {
		path, err := os.Executable()
		if err != nil {
			return notaloneProcessIdentity{}, err
		}
		path, err = filepath.EvalSymlinks(path)
		if err != nil {
			return notaloneProcessIdentity{}, err
		}
		return readNotaloneProcessIdentity(os.Getpid(), path)
	}
	h.program = func(context.Context) (notaloneProgramVersion, error) {
		return notaloneProgramVersion{Version: "4.0.6", Build: "29387"}, nil
	}
	h.certify = func(program notaloneProgramVersion, tables []notaloneTableSchema) notaloneProfileCertification {
		shape := notaloneSnapshotShape(tables)
		return notaloneProfileCertification{
			Status: "unverified", ProfileID: "wechat-4.0.6-29387-observed-states-v1",
			ProgramVersion: program.Version, Build: program.Build, DeclaredPrimaryKey: []string{"local_id"},
			StatusSemantics: "observed_subset_only", Continuity: "synthetic-source",
			SchemaShapeFingerprint: shape, Capabilities: notaloneSyntheticRuntimeCapabilities(),
			ReadProfile: &notaloneReadProfile{SchemaShapeFingerprint: shape, StatusSemanticsVerified: true,
				StatusRules: notalone40629387ObservedStatusRules()},
		}
	}
	t.Cleanup(h.close)
	if _, err = h.handle(context.Background(), notaloneHistoryRequest{Operation: "resolve", DisplayName: "合成目标", Consent: "selected-metadata-v1"}); err != nil {
		t.Fatal(err)
	}
	account, conversation := h.selected.Account, h.selected.Conversation
	if _, err = h.handle(context.Background(), notaloneHistoryRequest{Operation: "support", Account: account, Conversation: conversation, Consent: "selected-schema-v1"}); err != nil {
		t.Fatal(err)
	}
	targetValue, err := h.handle(context.Background(), notaloneHistoryRequest{Operation: "target", Account: account, Conversation: conversation, Consent: "selected-history-v1"})
	if err != nil {
		t.Fatal(err)
	}
	target := targetValue.(notaloneSnapshotTarget)
	if len(target.Tables) != 1 {
		t.Fatalf("预期一个合成分片表：%#v", target.Tables)
	}
	return h, notaloneHistoryRequest{
		Operation: "quote-read", Consent: "selected-quote-v1", Account: account, Conversation: conversation,
		Target: target.Descriptor, Partition: target.Tables[0].Partition, Table: target.Tables[0].Instance,
		LocalID: fmt.Sprint(notaloneQuoteTestLocalID), ServerID: fmt.Sprint(serverID), SentAt: "1700000000000",
	}
}

func notaloneQuoteTestResponse(t *testing.T, value any) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var response map[string]any
	if err = json.Unmarshal(encoded, &response); err != nil {
		t.Fatal(err)
	}
	return response
}

func TestNotAloneQuoteReadReturnsOnlyVerifiedExactReference(t *testing.T) {
	raw := notaloneQuoteTestXML("我晚点到", "1", "1841310816813489186", "synthetic-owner", "我", "先去吃饭吗？")
	h, request := notaloneQuoteProtocolFixture(t, notaloneQuoteTestRow{
		rawType: notaloneQuoteTestRawType, senderID: 1, status: 2, createAt: int64(1700000000), content: raw,
	})
	value, err := h.handle(context.Background(), request)
	if err != nil {
		t.Fatalf("已验证引用消息应能读取：%v", err)
	}
	response := notaloneQuoteTestResponse(t, value)
	digest := sha256.Sum256(raw)
	want := map[string]any{
		"format": "wechat-quote-message-v1", "accountKey": "synthetic-owner", "conversationKey": "friend-a",
		"sourceGeneration": h.selected.SourceGeneration, "partition": request.Partition, "table": request.Table,
		"localId": request.LocalID, "serverId": request.ServerID, "sentAt": request.SentAt,
		"replyText": "我晚点到", "referencedText": "先去吃饭吗？", "referencedSender": "我",
		"referencedSenderRole": "owner", "referencedType": "1", "referencedServerId": "1841310816813489186",
		"contentSha256": hex.EncodeToString(digest[:]),
	}
	for key, expected := range want {
		if response[key] != expected {
			t.Fatalf("引用wire字段 %s=%#v，期望 %#v", key, response[key], expected)
		}
	}
	encoded, _ := json.Marshal(response)
	for _, forbidden := range []string{string(raw), h.server.cfg.DBRoot, "message_content", "source-secret"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("响应泄漏原始XML、路径或列名：%q", forbidden)
		}
	}
}

func TestNotAloneQuoteReadRequiresExactRawTypeRoleAndStatus(t *testing.T) {
	otherType49 := int64((19 << 32) | 49)
	cases := []struct {
		name     string
		rawType  int64
		senderID int64
		status   int64
		wantCode string
	}{
		{name: "other 49 subtype", rawType: otherType49, senderID: 1, status: 2, wantCode: "history_quote_unavailable"},
		{name: "unmatched owner status", rawType: notaloneQuoteTestRawType, senderID: 1, status: 3, wantCode: "history_quote_state_unverified"},
		{name: "unmatched status", rawType: notaloneQuoteTestRawType, senderID: 1, status: 99, wantCode: "history_quote_state_unverified"},
		{name: "wrong owner status", rawType: notaloneQuoteTestRawType, senderID: 1, status: 4, wantCode: "history_quote_state_unverified"},
		{name: "wrong contact status", rawType: notaloneQuoteTestRawType, senderID: 2, status: 2, wantCode: "history_quote_state_unverified"},
		{name: "unmapped author", rawType: notaloneQuoteTestRawType, senderID: 3, status: 2, wantCode: "history_quote_association_unverified"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			h, request := notaloneQuoteProtocolFixture(t, notaloneQuoteTestRow{
				rawType: test.rawType, senderID: test.senderID, status: test.status, createAt: int64(1700000000),
				content: []byte("正文不得读取或解析"),
			})
			if _, err := h.handle(context.Background(), request); err == nil || err.Error() != test.wantCode {
				t.Fatalf("应拒绝且返回固定错误 %s，实际：%v", test.wantCode, err)
			}
		})
	}
}

func TestNotAloneQuoteReadRejectsMismatchedExactAssociation(t *testing.T) {
	mutations := []struct {
		name   string
		change func(*notaloneHistoryRequest)
	}{
		{name: "target", change: func(request *notaloneHistoryRequest) { request.Target = "different-target" }},
		{name: "partition", change: func(request *notaloneHistoryRequest) { request.Partition = strings.Repeat("a", 64) }},
		{name: "table", change: func(request *notaloneHistoryRequest) { request.Table = strings.Repeat("b", 64) }},
		{name: "server id", change: func(request *notaloneHistoryRequest) { request.ServerID = "0" }},
		{name: "sent at", change: func(request *notaloneHistoryRequest) { request.SentAt = "1700000000001" }},
	}
	for _, mutation := range mutations {
		t.Run(mutation.name, func(t *testing.T) {
			raw := notaloneQuoteTestXML("回复", "1", "9", "synthetic-owner", "我", "引用")
			h, request := notaloneQuoteProtocolFixture(t, notaloneQuoteTestRow{
				rawType: notaloneQuoteTestRawType, senderID: 1, status: 2, createAt: int64(1700000000), content: raw,
			})
			mutation.change(&request)
			if _, err := h.handle(context.Background(), request); err == nil || err.Error() != "history_quote_association_unverified" {
				t.Fatalf("错绑的引用位置必须返回固定关联错误：%v", err)
			}
		})
	}
}

func TestNotAloneQuoteReadRejectsNonCanonicalRequestBeforeConfigAccess(t *testing.T) {
	h := newNotaloneHistorySession(&server{})
	_, err := h.handle(context.Background(), notaloneHistoryRequest{
		Operation: "quote-read", Consent: "selected-quote-v1", Account: "owner", Conversation: "contact",
		Target: "fixed-target", Partition: strings.Repeat("a", 64), Table: strings.Repeat("b", 64),
		LocalID: "01", ServerID: "0",
	})
	if err == nil || err.Error() != "history_quote_request_invalid" {
		t.Fatalf("非规范ID应先于本机配置读取拒绝：%v", err)
	}
}

func TestNotAloneQuoteReadAcceptsNullSentAtAndDoesNotExpandMedia(t *testing.T) {
	raw := notaloneQuoteTestXML("这张照片真好看", "3", "0", "friend-a", "联系人", "<msg><img md5=\"not-a-real-image\"/></msg>")
	h, request := notaloneQuoteProtocolFixture(t, notaloneQuoteTestRow{
		rawType: notaloneQuoteTestRawType, senderID: 2, status: 4, setServerID: true, serverID: 0, createAt: nil, content: raw,
	})
	request.SentAt = ""
	value, err := h.handle(context.Background(), request)
	if err != nil {
		t.Fatalf("来源时间为null时空串应绑定null并接受引用媒体占位：%v", err)
	}
	response := notaloneQuoteTestResponse(t, value)
	if response["sentAt"] != nil || response["serverId"] != "0" || response["replyText"] != "这张照片真好看" || response["referencedText"] != nil ||
		response["referencedType"] != "3" || response["referencedServerId"] != nil || response["referencedSenderRole"] != "contact" {
		t.Fatalf("引用媒体应只保留占位且时间null：%#v", response)
	}
}

func TestNotAloneQuoteReadEmitsExplicitNullWireFields(t *testing.T) {
	raw := notaloneQuoteTestXML("回复标题", "", "", "", "", "")
	h, request := notaloneQuoteProtocolFixture(t, notaloneQuoteTestRow{
		rawType: notaloneQuoteTestRawType, senderID: 1, status: 2, setServerID: true, serverID: 0, createAt: nil, content: raw,
	})
	request.SentAt = ""
	value, err := h.handle(context.Background(), request)
	if err != nil {
		t.Fatalf("无可解析引用细节时仍应保留合法引用回复：%v", err)
	}
	response := notaloneQuoteTestResponse(t, value)
	for _, key := range []string{"sentAt", "referencedText", "referencedSender", "referencedType", "referencedServerId"} {
		if _, exists := response[key]; !exists || response[key] != nil {
			t.Fatalf("wire的可空字段 %s 必须显式为null：%#v", key, response)
		}
	}
	if response["replyText"] != "回复标题" || response["referencedSenderRole"] != "unknown" {
		t.Fatalf("回复文字及未知引用作者标记错误：%#v", response)
	}
}

func TestNotAloneQuoteReadRejectsMalformedOversizedAndCompressedXML(t *testing.T) {
	compressor, err := zstd.NewWriter(nil, zstd.WithEncoderConcurrency(1))
	if err != nil {
		t.Fatal(err)
	}
	compressedXML := notaloneQuoteTestXML("压缩回复", "1", "1841310816813489186", "synthetic-owner", "我", "压缩引用")
	compressed := compressor.EncodeAll(compressedXML, nil)
	oversizedCompressed := compressor.EncodeAll([]byte(`<msg>`+strings.Repeat("x", notaloneQuoteTestXMLByteLimit)+`</msg>`), nil)
	compressor.Close()
	cases := []struct {
		name     string
		content  []byte
		typeCode int64
		wantCode string
	}{
		{name: "malformed", content: []byte(`<msg><appmsg><refermsg></appmsg></msg>`), wantCode: "history_quote_metadata_invalid"},
		{name: "oversized", content: []byte(`<msg>` + strings.Repeat("x", notaloneQuoteTestXMLByteLimit) + `</msg>`), wantCode: "history_quote_too_large"},
		{name: "compressed oversized", content: oversizedCompressed, typeCode: notaloneImageXMLZstdContentType, wantCode: "history_quote_too_large"},
		{name: "zstd content type mismatch", content: compressed, wantCode: "history_quote_metadata_invalid"},
		{name: "bounded zstd", content: compressed, typeCode: notaloneImageXMLZstdContentType},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			h, request := notaloneQuoteProtocolFixture(t, notaloneQuoteTestRow{
				rawType: notaloneQuoteTestRawType, senderID: 1, status: 2, createAt: int64(1700000000), content: test.content, typeCode: test.typeCode,
			})
			value, readErr := h.handle(context.Background(), request)
			if test.wantCode != "" {
				if readErr == nil || readErr.Error() != test.wantCode {
					t.Fatalf("坏XML应返回固定错误 %s，实际：%v", test.wantCode, readErr)
				}
				return
			}
			if readErr != nil {
				t.Fatalf("有界zstd引用XML应可读：%v", readErr)
			}
			response := notaloneQuoteTestResponse(t, value)
			if got := response["referencedText"]; got != "压缩引用" {
				t.Fatalf("压缩引用解析错误：%#v", got)
			}
			digest := sha256.Sum256(compressedXML)
			if response["contentSha256"] != hex.EncodeToString(digest[:]) {
				t.Fatalf("摘要应绑定精确解码XML：%#v", response["contentSha256"])
			}
		})
	}
}
