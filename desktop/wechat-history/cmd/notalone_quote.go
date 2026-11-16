package main

import (
	"bytes"
	"context"
	"encoding/xml"
	"io"
	"reflect"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/klauspost/compress/zstd"
)

const (
	notaloneQuoteRawType       = int64(244813135921) // (57 << 32) | 49；其余49子类型不开放。
	notaloneQuoteXMLByteLimit  = 256 << 10
	notaloneQuoteZstdType      = int64(4)
	notaloneQuoteMaxXMLWindows = 8 << 20
	quoteReadFormat            = "wechat-quote-message-v1"
)

var notaloneQuoteZstdMagic = []byte{0x28, 0xb5, 0x2f, 0xfd}

// 生产路径关闭临时固定读者；测试可验证清理失败时不会发布已解析正文。
var notaloneQuoteSnapshotCloser = func(snapshot *notaloneSnapshot) error { return snapshot.Close() }

type notaloneQuoteReadResponse struct {
	Format               string  `json:"format"`
	AccountKey           string  `json:"accountKey"`
	ConversationKey      string  `json:"conversationKey"`
	SourceGeneration     string  `json:"sourceGeneration"`
	Partition            string  `json:"partition"`
	Table                string  `json:"table"`
	LocalID              string  `json:"localId"`
	ServerID             string  `json:"serverId"`
	SentAt               *string `json:"sentAt"`
	ReplyText            string  `json:"replyText"`
	ReferencedText       *string `json:"referencedText"`
	ReferencedSender     *string `json:"referencedSender"`
	ReferencedSenderRole string  `json:"referencedSenderRole"`
	ReferencedType       *string `json:"referencedType"`
	ReferencedServerID   *string `json:"referencedServerId"`
	ContentSHA256        string  `json:"contentSha256"`
}

type notaloneQuoteXMLDocument struct {
	XMLName xml.Name                 `xml:"msg"`
	AppMsgs []notaloneQuoteXMLAppMsg `xml:"appmsg"`
}

type notaloneQuoteXMLAppMsg struct {
	Titles    []string                   `xml:"title"`
	ReferMsgs []notaloneQuoteXMLReferMsg `xml:"refermsg"`
}

type notaloneQuoteXMLReferMsg struct {
	Types        []string `xml:"type"`
	ServerIDs    []string `xml:"svrid"`
	FromUsers    []string `xml:"fromusr"`
	DisplayNames []string `xml:"displayname"`
	Contents     []string `xml:"content"`
}

type notaloneQuoteParsedXML struct {
	ReplyText            string
	ReferencedFromUser   string
	ReferencedText       *string
	ReferencedSender     *string
	ReferencedSenderRole string
	ReferencedType       *string
	ReferencedServerID   *string
}

// 状态规则只覆盖本轮同源UI/metadata核验过的引用载体元组；不加入普通文字profile。
func notaloneCurrentQuoteStatusRules(report *notaloneSupportReport, profile *notaloneReadProfile, inspected *notaloneInspection, selected *notaloneResolved, snapshot *notaloneSnapshot) ([]notaloneStatusRule, bool) {
	if report == nil || profile == nil || inspected == nil || selected == nil || snapshot == nil ||
		report.Status != "supported" || report.ProfileID != "wechat-4.0.6-29387-observed-states-v1" ||
		report.ProgramVersion != "4.0.6" || report.Build != "29387" || report.StatusSemantics != "observed_subset_only" ||
		report.Capabilities["statusSemantics"] != "supported" || report.AccountKey != selected.Account ||
		report.ConversationKey != selected.Conversation || report.SourceGeneration != selected.SourceGeneration ||
		report.SchemaFingerprint != inspected.SchemaFingerprint || inspected.SourceGeneration != selected.SourceGeneration ||
		inspected.ScopeDigest != notaloneHash(selected.Account, selected.Conversation) || snapshot.selected.Account != selected.Account ||
		snapshot.selected.Conversation != selected.Conversation || snapshot.selected.SourceGeneration != selected.SourceGeneration ||
		!profile.StatusSemanticsVerified || !snapshot.profile.StatusSemanticsVerified ||
		profile.OpaqueStatusPolicy != "" || !notalone40629387ObservedStatusRulesMatch(profile.StatusRules) ||
		profile.SchemaShapeFingerprint == "" || profile.SchemaShapeFingerprint != notaloneSnapshotShape(inspected.Tables) ||
		snapshot.profile.SchemaShapeFingerprint != profile.SchemaShapeFingerprint ||
		!notalone40629387ObservedStatusRulesMatch(snapshot.profile.StatusRules) {
		return nil, false
	}
	return []notaloneStatusRule{
		{LocalType: notaloneQuoteRawType, Sender: "owner", Status: 2, State: notaloneMessageSent},
		{LocalType: notaloneQuoteRawType, Sender: "contact", Status: 4, State: notaloneMessageReceived},
	}, true
}

func notaloneDecodeQuoteXML(raw []byte, contentType int64) ([]byte, error) {
	invalid := func() ([]byte, error) { return nil, notaloneFailure("history_quote_metadata_invalid") }
	tooLarge := func() ([]byte, error) { return nil, notaloneFailure("history_quote_too_large") }
	if len(raw) == 0 {
		return invalid()
	}
	if len(raw) > notaloneQuoteXMLByteLimit {
		return tooLarge()
	}
	compressed := bytes.HasPrefix(raw, notaloneQuoteZstdMagic)
	if compressed != (contentType == notaloneQuoteZstdType) {
		return invalid()
	}
	if !compressed {
		return raw, nil
	}
	decoder, err := zstd.NewReader(bytes.NewReader(raw),
		zstd.WithDecoderConcurrency(1),
		zstd.WithDecoderMaxMemory(notaloneQuoteMaxXMLWindows),
		zstd.WithDecoderMaxWindow(notaloneQuoteMaxXMLWindows),
	)
	if err != nil {
		return invalid()
	}
	defer decoder.Close()
	decoded, err := io.ReadAll(io.LimitReader(decoder, notaloneQuoteXMLByteLimit+1))
	if err != nil {
		return invalid()
	}
	if len(decoded) == 0 {
		return invalid()
	}
	if len(decoded) > notaloneQuoteXMLByteLimit {
		return tooLarge()
	}
	return decoded, nil
}

func notaloneParseQuoteXML(raw []byte) (notaloneQuoteParsedXML, error) {
	result := notaloneQuoteParsedXML{ReferencedSenderRole: "unknown"}
	if !utf8.Valid(raw) {
		return result, notaloneFailure("history_quote_metadata_invalid")
	}
	content := stripMsgPrefix(string(raw))
	if content == "" || strings.ContainsRune(content, '\x00') {
		return result, notaloneFailure("history_quote_metadata_invalid")
	}
	decoder := xml.NewDecoder(strings.NewReader(content))
	decoder.Strict = true
	var document notaloneQuoteXMLDocument
	if err := decoder.Decode(&document); err != nil || document.XMLName.Local != "msg" || len(document.AppMsgs) != 1 {
		return result, notaloneFailure("history_quote_metadata_invalid")
	}
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return result, notaloneFailure("history_quote_metadata_invalid")
		}
		if text, ok := token.(xml.CharData); ok && strings.TrimSpace(string(text)) == "" {
			continue
		}
		return result, notaloneFailure("history_quote_metadata_invalid")
	}
	app := document.AppMsgs[0]
	if len(app.Titles) != 1 || len(app.ReferMsgs) != 1 {
		return result, notaloneFailure("history_quote_metadata_invalid")
	}
	result.ReplyText = app.Titles[0]
	reference := app.ReferMsgs[0]
	if len(reference.Types) > 1 || len(reference.ServerIDs) > 1 || len(reference.FromUsers) > 1 ||
		len(reference.DisplayNames) > 1 || len(reference.Contents) > 1 {
		return result, notaloneFailure("history_quote_metadata_invalid")
	}
	if len(reference.Types) == 1 && strings.TrimSpace(reference.Types[0]) != "" {
		value := strings.TrimSpace(reference.Types[0])
		if !notaloneCanonicalDecimal(value, true) {
			return result, notaloneFailure("history_quote_metadata_invalid")
		}
		result.ReferencedType = &value
		if value == "1" && len(reference.Contents) == 1 {
			text := reference.Contents[0]
			result.ReferencedText = &text
		}
	}
	if len(reference.FromUsers) == 1 {
		result.ReferencedFromUser = reference.FromUsers[0]
	}
	if len(reference.ServerIDs) == 1 && strings.TrimSpace(reference.ServerIDs[0]) != "" {
		value := strings.TrimSpace(reference.ServerIDs[0])
		if !notaloneCanonicalDecimal(value, true) {
			return result, notaloneFailure("history_quote_metadata_invalid")
		}
		if value != "0" {
			result.ReferencedServerID = &value
		}
	}
	if len(reference.DisplayNames) == 1 {
		value := strings.TrimSpace(reference.DisplayNames[0])
		if value != "" {
			result.ReferencedSender = &value
		}
	}
	return result, nil
}

func notaloneQuoteReferencedSenderRole(fromUser, owner, conversation string) string {
	switch strings.TrimSpace(fromUser) {
	case owner:
		return "owner"
	case conversation:
		return "contact"
	default:
		return "unknown"
	}
}

func (h *notaloneHistorySession) quoteReadSnapshot(ctx context.Context, request notaloneHistoryRequest) (*notaloneSnapshot, notaloneSnapshotTarget, func() error, error) {
	if h.snapshot != nil {
		if h.snapshotMode != "normal" || h.supportProfile == nil || !reflect.DeepEqual(h.snapshot.profile, *h.supportProfile) {
			return nil, notaloneSnapshotTarget{}, nil, notaloneFailure("history_quote_association_unverified")
		}
		target := h.snapshot.Target()
		if target.Descriptor == "" || target.Descriptor != request.Target || target.SourceGeneration != h.selected.SourceGeneration {
			return nil, notaloneSnapshotTarget{}, nil, notaloneFailure("history_quote_association_unverified")
		}
		return h.snapshot, target, func() error { return nil }, nil
	}
	tail := h.tail
	if h.snapshotMode != "normal" || tail == nil || h.inspected == nil || h.supportReport == nil || h.supportProfile == nil ||
		tail.target.Descriptor == "" || tail.target.Descriptor != request.Target || tail.scopeDigest != notaloneHash(h.selected.Account, h.selected.Conversation) ||
		tail.sourceGeneration != h.selected.SourceGeneration || tail.schemaFingerprint != h.inspected.SchemaFingerprint ||
		!reflect.DeepEqual(tail.profile, *h.supportProfile) || !tail.profile.IncrementalTailVerified {
		return nil, notaloneSnapshotTarget{}, nil, notaloneFailure("history_quote_association_unverified")
	}
	if err := h.ensureMessageGuard(); err != nil {
		return nil, notaloneSnapshotTarget{}, nil, notaloneFailure("history_quote_source_changed")
	}
	if tail.snapshot != nil {
		if !reflect.DeepEqual(tail.snapshot.profile, tail.profile) || tail.snapshot.Check() != nil || !notaloneSameSnapshotInstances(tail.target, tail.snapshot.Target()) {
			return nil, notaloneSnapshotTarget{}, nil, notaloneFailure("history_quote_source_changed")
		}
		return tail.snapshot, tail.target, func() error { return nil }, nil
	}
	life, cancel := context.WithCancel(ctx)
	snapshot, err := newNotaloneSnapshot(life, h.server, *h.selected, *h.inspected, *h.supportProfile)
	if err != nil {
		cancel()
		return nil, notaloneSnapshotTarget{}, nil, notaloneReadFailure(err, "history_quote_source_changed")
	}
	cleanup := func() error {
		closeErr := notaloneQuoteSnapshotCloser(snapshot)
		cancel()
		if closeErr != nil {
			h.cancel()
		}
		return closeErr
	}
	proof, proofErr := snapshot.FixedSnapshotProof(*h.inspected)
	if proofErr != nil || proof.Status != "verified" || proof.Format != notaloneFixedSnapshotProofFormat ||
		proof.Scope != "single-fixed-snapshot" || proof.AuthorizesSubsequentRead || proof.ExpectedPartitionCount == 0 ||
		proof.ExpectedPartitionCount != proof.CompletedPartitionCount || !notaloneSameSnapshotInstances(tail.target, snapshot.Target()) {
		_ = cleanup()
		return nil, notaloneSnapshotTarget{}, nil, notaloneReadFailure(proofErr, "history_quote_source_changed")
	}
	return snapshot, tail.target, cleanup, nil
}

func (h *notaloneHistorySession) readQuote(ctx context.Context, request notaloneHistoryRequest) (response notaloneQuoteReadResponse, resultErr error) {
	failed := notaloneQuoteReadResponse{}
	failAssociation := func() (notaloneQuoteReadResponse, error) {
		return failed, notaloneFailure("history_quote_association_unverified")
	}
	if h.selected == nil || h.selected.Account != request.Account || h.selected.Conversation != request.Conversation ||
		h.selected.SourceGeneration == "" || h.snapshotMode != "normal" ||
		h.supportReport == nil || h.supportProfile == nil || h.inspected == nil {
		return failAssociation()
	}
	snapshot, target, cleanupSnapshot, snapshotErr := h.quoteReadSnapshot(ctx, request)
	if snapshotErr != nil {
		return failed, snapshotErr
	}
	defer func() {
		if closeErr := cleanupSnapshot(); closeErr != nil {
			h.cancel()
			response = notaloneQuoteReadResponse{}
			resultErr = notaloneFailure("history_quote_source_changed")
		}
	}()
	quoteRules, quoteProfileReady := notaloneCurrentQuoteStatusRules(h.supportReport, h.supportProfile, h.inspected, h.selected, snapshot)
	if target.Descriptor == "" || target.Descriptor != request.Target || target.SourceGeneration != h.selected.SourceGeneration || !quoteProfileReady {
		return failAssociation()
	}
	if err := h.ensureMessageGuard(); err != nil {
		return failed, notaloneFailure("history_quote_source_changed")
	}
	if err := snapshot.Check(); err != nil {
		return failed, notaloneFailure("history_quote_source_changed")
	}
	matchedShard := -1
	for index, shard := range snapshot.shards {
		if shard.partition == request.Partition && shard.instance == request.Table {
			if matchedShard >= 0 {
				return failAssociation()
			}
			matchedShard = index
		}
	}
	if matchedShard < 0 {
		return failAssociation()
	}
	localID, errLocal := strconv.ParseInt(request.LocalID, 10, 64)
	if errLocal != nil || localID < 0 {
		return failAssociation()
	}
	shard := snapshot.shards[matchedShard]
	snapshot.mu.Lock()
	defer snapshot.mu.Unlock()
	if snapshot.checkLocked() != nil || matchedShard >= len(snapshot.shards) {
		return failed, notaloneFailure("history_quote_source_changed")
	}
	query := `SELECT local_id,server_id,local_type,real_sender_id,create_time,status`
	if shard.hasContentTypeColumn {
		query += `,WCDB_CT_message_content`
	}
	query += ` FROM ` + quoteIdent(snapshot.table) + ` WHERE local_id=? LIMIT 2`
	rows, err := shard.reader.QueryBounded(ctx, 2, query, localID)
	if err != nil {
		if snapshot.checkLocked() != nil || h.ensureMessageGuard() != nil {
			return failed, notaloneFailure("history_quote_source_changed")
		}
		return failed, notaloneReadFailure(err, "history_quote_read_failed")
	}
	if len(rows) != 1 {
		return failed, notaloneFailure("history_quote_unavailable")
	}
	expected := &notaloneQuoteExpectedIdentity{
		partition: request.Partition, table: request.Table, localID: request.LocalID,
		serverID: request.ServerID, sentAt: request.SentAt,
	}
	return h.readQuoteFromSnapshotRowLocked(ctx, snapshot, shard, rows[0], quoteRules, expected)
}
