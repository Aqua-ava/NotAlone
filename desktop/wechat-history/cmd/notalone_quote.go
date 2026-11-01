package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"io"
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

func (h *notaloneHistorySession) readQuote(ctx context.Context, request notaloneHistoryRequest) (notaloneQuoteReadResponse, error) {
	failed := notaloneQuoteReadResponse{}
	failAssociation := func() (notaloneQuoteReadResponse, error) {
		return failed, notaloneFailure("history_quote_association_unverified")
	}
	if h.selected == nil || h.selected.Account != request.Account || h.selected.Conversation != request.Conversation ||
		h.selected.SourceGeneration == "" || h.snapshot == nil || h.snapshotMode != "normal" ||
		h.supportReport == nil || h.supportProfile == nil || h.inspected == nil {
		return failAssociation()
	}
	quoteRules, quoteProfileReady := notaloneCurrentQuoteStatusRules(h.supportReport, h.supportProfile, h.inspected, h.selected, h.snapshot)
	target := h.snapshot.Target()
	if target.Descriptor == "" || target.Descriptor != request.Target || target.SourceGeneration != h.selected.SourceGeneration ||
		!quoteProfileReady {
		return failAssociation()
	}
	if err := h.ensureMessageGuard(); err != nil {
		return failed, notaloneFailure("history_quote_source_changed")
	}
	if err := h.snapshot.Check(); err != nil {
		return failed, notaloneFailure("history_quote_source_changed")
	}
	matchedShard := -1
	for index, shard := range h.snapshot.shards {
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
	serverID, errServer := strconv.ParseInt(request.ServerID, 10, 64)
	if errLocal != nil || errServer != nil {
		return failAssociation()
	}
	if request.SentAt != "" {
		if !notaloneCanonicalDecimal(request.SentAt, true) {
			return failed, notaloneFailure("history_quote_association_unverified")
		}
	}
	shard := h.snapshot.shards[matchedShard]
	h.snapshot.mu.Lock()
	defer h.snapshot.mu.Unlock()
	if h.snapshot.checkLocked() != nil || matchedShard >= len(h.snapshot.shards) {
		return failed, notaloneFailure("history_quote_source_changed")
	}
	metadataQuery := `SELECT local_id,server_id,local_type,real_sender_id,create_time,status,WCDB_CT_message_content
FROM ` + quoteIdent(h.snapshot.table) + ` WHERE local_id=? LIMIT 2`
	rows, err := shard.reader.QueryBounded(ctx, 2, metadataQuery, localID)
	if err != nil {
		return failed, notaloneFailure("history_quote_read_failed")
	}
	if len(rows) != 1 {
		return failed, notaloneFailure("history_quote_unavailable")
	}
	row := rows[0]
	rowLocalID, localOK := row["local_id"].(int64)
	rowServerID, serverOK := row["server_id"].(int64)
	rowType, typeOK := row["local_type"].(int64)
	status, statusOK := row["status"].(int64)
	senderID, senderOK := row["real_sender_id"].(int64)
	contentType, contentTypeOK := row["WCDB_CT_message_content"].(int64)
	if !contentTypeOK && row["WCDB_CT_message_content"] == nil {
		contentType, contentTypeOK = 0, true
	}
	if !localOK || !serverOK || !typeOK || !statusOK || !senderOK || !contentTypeOK || rowLocalID != localID || rowServerID != serverID {
		return failed, notaloneFailure("history_quote_association_unverified")
	}
	if rowType != notaloneQuoteRawType {
		return failed, notaloneFailure("history_quote_unavailable")
	}
	sourceTime, timeColumnPresent := row["create_time"]
	var sentAt *string
	if !timeColumnPresent {
		return failed, notaloneFailure("history_quote_metadata_invalid")
	}
	if sourceTime != nil {
		sourceSentAt, timePresent := sourceTime.(int64)
		if !timePresent {
			return failed, notaloneFailure("history_quote_metadata_invalid")
		}
		if sourceSentAt < 0 || sourceSentAt > 253402300799 {
			return failed, notaloneFailure("history_quote_association_unverified")
		}
		value := strconv.FormatInt(sourceSentAt*1000, 10)
		sentAt = &value
		if request.SentAt == "" || request.SentAt != value {
			return failed, notaloneFailure("history_quote_association_unverified")
		}
	} else if request.SentAt != "" {
		return failed, notaloneFailure("history_quote_association_unverified")
	}
	if !h.snapshot.profile.StatusSemanticsVerified {
		return failed, notaloneFailure("history_quote_state_unverified")
	}
	names, err := shard.reader.QueryBounded(ctx, 2, "SELECT user_name FROM Name2Id WHERE rowid=? LIMIT 2", senderID)
	if err != nil {
		return failed, notaloneFailure("history_quote_read_failed")
	}
	if len(names) != 1 {
		return failed, notaloneFailure("history_quote_association_unverified")
	}
	currentSender := rowString(names[0], "user_name")
	currentRole := "unknown"
	switch currentSender {
	case h.snapshot.senderOwner:
		currentRole = "owner"
	case h.selected.Conversation:
		currentRole = "contact"
	default:
		return failed, notaloneFailure("history_quote_association_unverified")
	}
	serverIDString := strconv.FormatInt(rowServerID, 10)
	quoteStatusProfile := notaloneReadProfile{StatusSemanticsVerified: true, StatusRules: quoteRules}
	decision := notaloneClassifyStatus(quoteStatusProfile, rowType, currentRole, status, &serverIDString)
	if !decision.StateVerified || !decision.HistoryEligible {
		return failed, notaloneFailure("history_quote_state_unverified")
	}
	contentQuery := `SELECT CASE WHEN local_id=? AND server_id=? AND local_type=? AND real_sender_id=? AND status=?
AND create_time IS ? AND WCDB_CT_message_content=? THEN length(CAST(message_content AS BLOB)) ELSE NULL END AS quote_content_length
FROM ` + quoteIdent(h.snapshot.table) + ` WHERE local_id=? LIMIT 2`
	contentRows, err := shard.reader.QueryBounded(ctx, 2, contentQuery,
		rowLocalID, rowServerID, rowType, senderID, status, sourceTime, contentType, localID)
	if err != nil {
		return failed, notaloneFailure("history_quote_read_failed")
	}
	if len(contentRows) != 1 {
		return failed, notaloneFailure("history_quote_source_changed")
	}
	contentLength, lengthOK := contentRows[0]["quote_content_length"].(int64)
	if !lengthOK {
		return failed, notaloneFailure("history_quote_metadata_invalid")
	}
	if contentLength > notaloneQuoteXMLByteLimit {
		return failed, notaloneFailure("history_quote_too_large")
	}
	if contentLength <= 0 {
		return failed, notaloneFailure("history_quote_metadata_invalid")
	}
	bodyQuery := `SELECT CASE WHEN local_id=? AND server_id=? AND local_type=? AND real_sender_id=? AND status=?
AND create_time IS ? AND WCDB_CT_message_content=? AND length(CAST(message_content AS BLOB))<=?
THEN message_content ELSE NULL END AS quote_xml FROM ` + quoteIdent(h.snapshot.table) + ` WHERE local_id=? LIMIT 2`
	bodyRows, err := shard.reader.QueryBounded(ctx, 2, bodyQuery,
		rowLocalID, rowServerID, rowType, senderID, status, row["create_time"], contentType,
		int64(notaloneQuoteXMLByteLimit), localID)
	if err != nil {
		return failed, notaloneFailure("history_quote_read_failed")
	}
	if len(bodyRows) != 1 {
		return failed, notaloneFailure("history_quote_source_changed")
	}
	encodedXML := rowBytes(bodyRows[0], "quote_xml")
	if len(encodedXML) == 0 || int64(len(encodedXML)) != contentLength {
		return failed, notaloneFailure("history_quote_metadata_invalid")
	}
	if h.snapshot.checkLocked() != nil || h.currentAccount() != nil || h.ensureMessageGuard() != nil {
		return failed, notaloneFailure("history_quote_source_changed")
	}
	decodedXML, err := notaloneDecodeQuoteXML(encodedXML, contentType)
	if err != nil {
		return failed, err
	}
	parsed, err := notaloneParseQuoteXML(decodedXML)
	if err != nil {
		return failed, err
	}
	parsed.ReferencedSenderRole = notaloneQuoteReferencedSenderRole(parsed.ReferencedFromUser, h.snapshot.senderOwner, h.selected.Conversation)
	digest := sha256.Sum256(decodedXML)
	return notaloneQuoteReadResponse{
		Format: quoteReadFormat, AccountKey: h.selected.Account, ConversationKey: h.selected.Conversation,
		SourceGeneration: h.selected.SourceGeneration, Partition: request.Partition, Table: request.Table,
		LocalID: request.LocalID, ServerID: request.ServerID, SentAt: sentAt,
		ReplyText: parsed.ReplyText, ReferencedText: parsed.ReferencedText, ReferencedSender: parsed.ReferencedSender,
		ReferencedSenderRole: parsed.ReferencedSenderRole, ReferencedType: parsed.ReferencedType,
		ReferencedServerID: parsed.ReferencedServerID, ContentSHA256: hex.EncodeToString(digest[:]),
	}, nil
}
