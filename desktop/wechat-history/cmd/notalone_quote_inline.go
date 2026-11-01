package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"

	"github.com/r266-tech/wx-cli/v2/internal/wcdb"
)

type notaloneInlineQuoteContext struct {
	session *notaloneHistorySession
	rules   []notaloneStatusRule
	ready   bool
}

type notaloneQuoteExpectedIdentity struct {
	partition string
	table     string
	localID   string
	serverID  string
	sentAt    string
}

func (h *notaloneHistorySession) inlineQuoteContext(snapshot *notaloneSnapshot, report *notaloneSupportReport, profile *notaloneReadProfile) notaloneInlineQuoteContext {
	rules, ready := notaloneCurrentQuoteStatusRules(report, profile, h.inspected, h.selected, snapshot)
	return notaloneInlineQuoteContext{session: h, rules: rules, ready: ready}
}

func (inline notaloneInlineQuoteContext) read(ctx context.Context, snapshot *notaloneSnapshot, shard *notaloneSnapshotShard, row wcdb.Row) (notaloneQuoteReadResponse, error) {
	if !inline.ready {
		return notaloneQuoteReadResponse{}, notaloneFailure("history_quote_state_unverified")
	}
	if inline.session == nil {
		return notaloneQuoteReadResponse{}, notaloneFailure("history_quote_association_unverified")
	}
	return inline.session.readQuoteFromSnapshotRowLocked(ctx, snapshot, shard, row, inline.rules, nil)
}

func notaloneInlineQuoteErrorCode(err error) string {
	if err == nil {
		return ""
	}
	switch err.Error() {
	case "history_quote_unavailable", "history_quote_metadata_invalid", "history_quote_too_large",
		"history_quote_state_unverified", "history_quote_association_unverified", "history_quote_read_failed":
		return err.Error()
	default:
		return ""
	}
}

// 调用方持有 snapshot.mu；正常 page、tail 和显式 quote-read 共用这一条固定快照行读取路径。
func (h *notaloneHistorySession) readQuoteFromSnapshotRowLocked(ctx context.Context, snapshot *notaloneSnapshot, shard *notaloneSnapshotShard, row wcdb.Row, quoteRules []notaloneStatusRule, expected *notaloneQuoteExpectedIdentity) (notaloneQuoteReadResponse, error) {
	failed := notaloneQuoteReadResponse{}
	if h == nil || h.selected == nil || snapshot == nil || shard == nil || row == nil ||
		snapshot.selected.Account != h.selected.Account || snapshot.selected.Conversation != h.selected.Conversation ||
		snapshot.selected.SourceGeneration != h.selected.SourceGeneration {
		return failed, notaloneFailure("history_quote_association_unverified")
	}
	if ctx == nil || ctx.Err() != nil {
		return failed, notaloneFailure("history_snapshot_cancelled")
	}
	if snapshot.checkLocked() != nil || h.currentAccount() != nil || h.ensureMessageGuard() != nil {
		return failed, notaloneFailure("history_quote_source_changed")
	}
	if expected != nil && (expected.partition != shard.partition || expected.table != shard.instance) {
		return failed, notaloneFailure("history_quote_association_unverified")
	}
	localID, localOK := row["local_id"].(int64)
	serverID, serverOK := row["server_id"].(int64)
	localType, typeOK := row["local_type"].(int64)
	status, statusOK := row["status"].(int64)
	senderID, senderOK := row["real_sender_id"].(int64)
	if !localOK || !serverOK || !typeOK || !statusOK || !senderOK || localID < 0 || serverID < 0 {
		return failed, notaloneFailure("history_quote_association_unverified")
	}
	if localType != notaloneQuoteRawType {
		return failed, notaloneFailure("history_quote_unavailable")
	}
	localIDString := strconv.FormatInt(localID, 10)
	serverIDString := strconv.FormatInt(serverID, 10)
	sourceTime, timeColumnPresent := row["create_time"]
	if !timeColumnPresent {
		return failed, notaloneFailure("history_quote_metadata_invalid")
	}
	var sentAt *string
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
	}
	if expected != nil && (expected.localID != localIDString || expected.serverID != serverIDString ||
		(expected.sentAt == "" && sentAt != nil) || (expected.sentAt != "" && (sentAt == nil || expected.sentAt != *sentAt))) {
		return failed, notaloneFailure("history_quote_association_unverified")
	}
	if !notaloneStatusRulesValid(quoteRules) {
		return failed, notaloneFailure("history_quote_state_unverified")
	}
	names, err := shard.reader.QueryBounded(ctx, 2, "SELECT user_name FROM Name2Id WHERE rowid=? LIMIT 2", senderID)
	if err != nil {
		if snapshot.checkLocked() != nil || h.ensureMessageGuard() != nil {
			return failed, notaloneFailure("history_quote_source_changed")
		}
		return failed, notaloneFailure("history_quote_read_failed")
	}
	if len(names) != 1 {
		return failed, notaloneFailure("history_quote_association_unverified")
	}
	currentSender := rowString(names[0], "user_name")
	currentRole := "unknown"
	switch currentSender {
	case snapshot.senderOwner:
		currentRole = "owner"
	case h.selected.Conversation:
		currentRole = "contact"
	default:
		return failed, notaloneFailure("history_quote_association_unverified")
	}
	decision := notaloneClassifyStatus(notaloneReadProfile{StatusSemanticsVerified: true, StatusRules: quoteRules}, localType, currentRole, status, &serverIDString)
	if !decision.StateVerified || !decision.HistoryEligible {
		return failed, notaloneFailure("history_quote_state_unverified")
	}
	contentType, contentTypeOK := row["WCDB_CT_message_content"].(int64)
	if !contentTypeOK && row["WCDB_CT_message_content"] == nil {
		contentType, contentTypeOK = 0, true
	}
	if !contentTypeOK {
		return failed, notaloneFailure("history_quote_metadata_invalid")
	}
	contentTypePredicate := "WCDB_CT_message_content=?"
	contentTypeArgument := any(contentType)
	if !shard.hasContentTypeColumn {
		contentTypePredicate = "?=0"
		contentTypeArgument = int64(0)
	}
	contentQuery := `SELECT CASE WHEN local_id=? AND server_id=? AND local_type=? AND real_sender_id=? AND status=?
AND create_time IS ? AND ` + contentTypePredicate + ` THEN length(CAST(message_content AS BLOB)) ELSE NULL END AS quote_content_length
FROM ` + quoteIdent(snapshot.table) + ` WHERE local_id=? LIMIT 2`
	contentRows, err := shard.reader.QueryBounded(ctx, 2, contentQuery,
		localID, serverID, localType, senderID, status, sourceTime, contentTypeArgument, localID)
	if err != nil {
		if snapshot.checkLocked() != nil || h.ensureMessageGuard() != nil {
			return failed, notaloneFailure("history_quote_source_changed")
		}
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
AND create_time IS ? AND ` + contentTypePredicate + ` AND length(CAST(message_content AS BLOB))<=?
THEN message_content ELSE NULL END AS quote_xml FROM ` + quoteIdent(snapshot.table) + ` WHERE local_id=? LIMIT 2`
	bodyRows, err := shard.reader.QueryBounded(ctx, 2, bodyQuery,
		localID, serverID, localType, senderID, status, sourceTime, contentTypeArgument,
		int64(notaloneQuoteXMLByteLimit), localID)
	if err != nil {
		if snapshot.checkLocked() != nil || h.ensureMessageGuard() != nil {
			return failed, notaloneFailure("history_quote_source_changed")
		}
		return failed, notaloneFailure("history_quote_read_failed")
	}
	if len(bodyRows) != 1 {
		return failed, notaloneFailure("history_quote_source_changed")
	}
	encodedXML := rowBytes(bodyRows[0], "quote_xml")
	if len(encodedXML) == 0 || int64(len(encodedXML)) != contentLength {
		return failed, notaloneFailure("history_quote_metadata_invalid")
	}
	if snapshot.checkLocked() != nil || h.currentAccount() != nil || h.ensureMessageGuard() != nil {
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
	if strings.TrimSpace(parsed.ReplyText) == "" {
		return failed, notaloneFailure("history_quote_metadata_invalid")
	}
	if len(parsed.ReplyText) > notaloneTextByteLimit || (parsed.ReferencedText != nil && len(*parsed.ReferencedText) > notaloneTextByteLimit) ||
		(parsed.ReferencedSender != nil && len(*parsed.ReferencedSender) > 255) {
		return failed, notaloneFailure("history_quote_too_large")
	}
	parsed.ReferencedSenderRole = notaloneQuoteReferencedSenderRole(parsed.ReferencedFromUser, snapshot.senderOwner, h.selected.Conversation)
	digest := sha256.Sum256(decodedXML)
	return notaloneQuoteReadResponse{
		Format: quoteReadFormat, AccountKey: h.selected.Account, ConversationKey: h.selected.Conversation,
		SourceGeneration: h.selected.SourceGeneration, Partition: shard.partition, Table: shard.instance,
		LocalID: localIDString, ServerID: serverIDString, SentAt: sentAt,
		ReplyText: parsed.ReplyText, ReferencedText: parsed.ReferencedText, ReferencedSender: parsed.ReferencedSender,
		ReferencedSenderRole: parsed.ReferencedSenderRole, ReferencedType: parsed.ReferencedType,
		ReferencedServerID: parsed.ReferencedServerID, ContentSHA256: hex.EncodeToString(digest[:]),
	}, nil
}
