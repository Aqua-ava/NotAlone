package main

import (
	"bytes"
	"context"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/xml"
	"hash"
	"image"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/klauspost/compress/zstd"
	"github.com/r266-tech/wx-cli/v2/internal/config"
	"github.com/r266-tech/wx-cli/v2/internal/wxkind"
)

const (
	notaloneImageXMLByteLimit        = 256 << 10
	notaloneImageSourceByteLimit     = 64 << 20
	notaloneImageMaxBytes            = 32 << 20
	notaloneImageChunkBytes          = 64 << 10
	notaloneImageMaxDimension        = 100_000
	notaloneImageMaxPixelCount       = 100_000_000
	notaloneImagePackedInfoByteLimit = 4096
	notaloneImageResourceTableID     = "wechat-message-resource-v1"
	notaloneImageQualityProofKind    = "wechat-cdn-big-hd-exact-content-v3"
	notaloneImageXMLZstdContentType  = int64(4)
)

var notaloneImageXMLZstdMagic = []byte{0x28, 0xb5, 0x2f, 0xfd}

var notaloneImageDigestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

type notaloneImageXMLDocument struct {
	XMLName xml.Name `xml:"msg"`
	Images  []struct {
		MD5         string `xml:"md5,attr"`
		Length      int64  `xml:"length,attr"`
		HDLength    int64  `xml:"hdlength,attr"`
		CdnBigURL   string `xml:"cdnbigimgurl,attr"`
		CdnHDWidth  *int   `xml:"cdnhdwidth,attr"`
		CdnHDHeight *int   `xml:"cdnhdheight,attr"`
	} `xml:"img"`
}

type notaloneOriginalImageMetadata struct {
	MD5         string
	Length      int64
	HDLength    int64
	HDWidth     *int
	HDHeight    *int
	BigURLFound bool
}

type notaloneImageQualityProof struct {
	Kind                string   `json:"kind"`
	MessageMD5          string   `json:"messageMd5"`
	HDLength            int64    `json:"hdLength"`
	HDWidth             *int     `json:"hdWidth"`
	HDHeight            *int     `json:"hdHeight"`
	BigImageURLFound    bool     `json:"bigImageUrlPresent"`
	ResourceInfoID      string   `json:"resourceInfoId"`
	MatchingResourceIDs []string `json:"matchingResourceIds"`
	ResourceSize        int64    `json:"resourceSize"`
	VerifiedBytes       int64    `json:"verifiedBytes"`
	VerifiedSHA256      string   `json:"verifiedSha256"`
	ContentWidth        int      `json:"contentWidth"`
	ContentHeight       int      `json:"contentHeight"`
}

type notaloneImageOpenResponse struct {
	Protocol                 string                    `json:"protocol"`
	ResourceToken            string                    `json:"resourceToken"`
	SourceGeneration         string                    `json:"sourceGeneration"`
	ResourceSourceGeneration string                    `json:"resourceSourceGeneration"`
	Target                   string                    `json:"target"`
	Partition                string                    `json:"partition"`
	Table                    string                    `json:"table"`
	LocalID                  string                    `json:"localId"`
	ServerID                 string                    `json:"serverId"`
	SentAt                   string                    `json:"sentAt"`
	ResourceTable            string                    `json:"resourceTable"`
	ResourceID               string                    `json:"resourceId"`
	ResourceTypeRaw          int64                     `json:"resourceTypeRaw"`
	VariantCode              int64                     `json:"variantCode"`
	Complete                 bool                      `json:"complete"`
	Quality                  string                    `json:"quality"`
	QualityProof             notaloneImageQualityProof `json:"qualityProof"`
	Envelope                 string                    `json:"envelope"`
	SourceEnvelope           string                    `json:"sourceEnvelope"`
	ExpectedBytes            int64                     `json:"expectedBytes"`
	ExpectedSHA256           string                    `json:"expectedSha256"`
	MimeType                 string                    `json:"mimeType"`
}

type notaloneImageReadResponse struct {
	ResourceToken    string `json:"resourceToken"`
	SourceGeneration string `json:"sourceGeneration"`
	Offset           int64  `json:"offset"`
	BytesRead        int64  `json:"bytesRead"`
	TotalBytes       int64  `json:"totalBytes"`
	ChunkBase64      string `json:"chunkBase64"`
	EOF              bool   `json:"eof"`
	VerifiedSHA256   string `json:"verifiedSha256,omitempty"`
}

type notaloneImageCloseResponse struct {
	Closed bool `json:"closed"`
}

type notaloneImageResourceRecord struct {
	ID                   int64
	TypeRaw              int64
	Size                 int64
	Status               int64
	DataIndex            string
	CreateTime           int64
	AccessTime           int64
	PackedInfoLength     int64
	PackedInfoSHA256     string
	InfoID               int64
	InfoPackedInfoLength int64
	InfoPackedInfoSHA256 string
	CacheMD5             string
	Details              []notaloneImageResourceDetail
	MatchingDetails      []notaloneImageResourceDetail
}

type notaloneImageResourceDetail struct {
	ID               int64
	TypeRaw          int64
	Size             int64
	Status           int64
	DataIndex        string
	CreateTime       int64
	AccessTime       int64
	PackedInfoLength int64
	PackedInfoSHA256 string
	PackedMD5s       []string
	PackedInfoValid  bool
}

type notaloneOpenImage struct {
	metadata notaloneImageOpenResponse
	data     []byte
	next     int64
	digest   hash.Hash
	guards   []*notaloneSourceGuard
}

func notaloneCanonicalDecimal(value string, allowZero bool) bool {
	if value == "" || len(value) > 20 {
		return false
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || strconv.FormatInt(parsed, 10) != value {
		return false
	}
	return allowZero || parsed != 0
}

func notaloneImageTokenValid(token string) bool {
	if len(token) != 43 {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(token)
	return err == nil && len(decoded) == 32
}

func notalonePackedMD5s(data []byte, byteLength int64) (map[string]struct{}, bool) {
	if byteLength < 0 || byteLength > notaloneImagePackedInfoByteLimit || int64(len(data)) != byteLength {
		return nil, false
	}
	values := make(map[string]struct{})
	for _, value := range packedStrings(data) {
		value = strings.ToLower(strings.TrimSpace(value))
		if md5LikeRe.MatchString(value) {
			values[value] = struct{}{}
		}
	}
	return values, true
}

func notaloneSinglePackedMD5(data []byte, byteLength int64) (string, bool) {
	values, valid := notalonePackedMD5s(data, byteLength)
	if !valid || len(values) != 1 {
		return "", false
	}
	for value := range values {
		return value, true
	}
	return "", false
}

func notaloneDecodeImageXML(raw []byte, contentType int64) ([]byte, error) {
	fail := func() ([]byte, error) { return nil, notaloneFailure("history_image_metadata_invalid") }
	if len(raw) == 0 || len(raw) > notaloneImageXMLByteLimit {
		return fail()
	}
	compressed := bytes.HasPrefix(raw, notaloneImageXMLZstdMagic)
	if compressed != (contentType == notaloneImageXMLZstdContentType) {
		return fail()
	}
	if !compressed {
		return raw, nil
	}
	decoder, err := zstd.NewReader(nil,
		zstd.WithDecoderConcurrency(1),
		zstd.WithDecoderMaxMemory(8<<20),
		zstd.WithDecoderMaxWindow(8<<20),
		zstd.WithDecodeAllCapLimit(true),
	)
	if err != nil {
		return fail()
	}
	defer decoder.Close()
	decoded, err := decoder.DecodeAll(raw, make([]byte, 0, notaloneImageXMLByteLimit))
	if err != nil || len(decoded) == 0 || len(decoded) > notaloneImageXMLByteLimit {
		return fail()
	}
	return decoded, nil
}

func notaloneParseOriginalImageXML(raw []byte) (notaloneOriginalImageMetadata, error) {
	result := notaloneOriginalImageMetadata{}
	if len(raw) == 0 || len(raw) > notaloneImageXMLByteLimit {
		return result, notaloneFailure("history_image_metadata_invalid")
	}
	content := stripMsgPrefix(string(raw))
	if content == "" || strings.ContainsRune(content, '\x00') {
		return result, notaloneFailure("history_image_metadata_invalid")
	}
	var parsed notaloneImageXMLDocument
	if xml.Unmarshal([]byte(content), &parsed) != nil || parsed.XMLName.Local != "msg" || len(parsed.Images) != 1 {
		return result, notaloneFailure("history_image_metadata_invalid")
	}
	img := parsed.Images[0]
	md5Value := strings.ToLower(strings.TrimSpace(img.MD5))
	if !md5LikeRe.MatchString(md5Value) || img.HDLength <= 0 || img.HDLength > notaloneImageMaxBytes ||
		strings.TrimSpace(img.CdnBigURL) == "" || (img.CdnHDWidth == nil) != (img.CdnHDHeight == nil) {
		return result, notaloneFailure("history_image_metadata_invalid")
	}
	var hdWidth, hdHeight *int
	if img.CdnHDWidth != nil {
		width, height := *img.CdnHDWidth, *img.CdnHDHeight
		if width < 0 || height < 0 || (width == 0) != (height == 0) {
			return result, notaloneFailure("history_image_metadata_invalid")
		}
		if width > 0 {
			if width > notaloneImageMaxDimension || height > notaloneImageMaxDimension || int64(width)*int64(height) > notaloneImageMaxPixelCount {
				return result, notaloneFailure("history_image_metadata_invalid")
			}
			hdWidth, hdHeight = &width, &height
		}
	}
	result = notaloneOriginalImageMetadata{MD5: md5Value, Length: img.Length, HDLength: img.HDLength,
		HDWidth: hdWidth, HDHeight: hdHeight, BigURLFound: true}
	return result, nil
}

func notaloneBMPDimensions(data []byte) (int, int, error) {
	fail := func() (int, int, error) { return 0, 0, notaloneFailure("history_image_quality_unverified") }
	if len(data) < 26 || len(data) > notaloneImageMaxBytes || !bytes.Equal(data[:2], []byte("BM")) {
		return fail()
	}
	if binary.LittleEndian.Uint32(data[2:6]) != uint32(len(data)) || binary.LittleEndian.Uint16(data[6:8]) != 0 || binary.LittleEndian.Uint16(data[8:10]) != 0 {
		return fail()
	}
	pixelOffset := uint64(binary.LittleEndian.Uint32(data[10:14]))
	dibSize := binary.LittleEndian.Uint32(data[14:18])
	if dibSize != 12 && dibSize != 40 && dibSize != 52 && dibSize != 56 && dibSize != 64 && dibSize != 108 && dibSize != 124 {
		return fail()
	}
	headerEnd := uint64(14) + uint64(dibSize)
	if headerEnd > uint64(len(data)) {
		return fail()
	}
	var width, height int64
	var bitsPerPixel uint64
	var compression, imageSize, colorsUsed uint32
	var coreHeader bool
	if dibSize == 12 {
		coreHeader = true
		width = int64(binary.LittleEndian.Uint16(data[18:20]))
		height = int64(binary.LittleEndian.Uint16(data[20:22]))
		if binary.LittleEndian.Uint16(data[22:24]) != 1 {
			return fail()
		}
		bitsPerPixel = uint64(binary.LittleEndian.Uint16(data[24:26]))
	} else {
		width = int64(int32(binary.LittleEndian.Uint32(data[18:22])))
		height = int64(int32(binary.LittleEndian.Uint32(data[22:26])))
		if binary.LittleEndian.Uint16(data[26:28]) != 1 {
			return fail()
		}
		bitsPerPixel = uint64(binary.LittleEndian.Uint16(data[28:30]))
		compression = binary.LittleEndian.Uint32(data[30:34])
		imageSize = binary.LittleEndian.Uint32(data[34:38])
		colorsUsed = binary.LittleEndian.Uint32(data[46:50])
	}
	if width <= 0 || width > notaloneImageMaxDimension || height == 0 {
		return fail()
	}
	if height < 0 {
		if coreHeader || compression != 0 && compression != 3 && compression != 6 {
			return fail()
		}
		height = -height
	}
	if height > notaloneImageMaxDimension || width*height > notaloneImageMaxPixelCount {
		return fail()
	}
	if coreHeader {
		switch bitsPerPixel {
		case 1, 4, 8, 24:
		default:
			return fail()
		}
	} else {
		switch bitsPerPixel {
		case 1, 4, 8, 16, 24, 32:
		default:
			return fail()
		}
		switch compression {
		case 0, 3, 6:
		case 1:
			if bitsPerPixel != 8 {
				return fail()
			}
		case 2:
			if bitsPerPixel != 4 {
				return fail()
			}
		default:
			return fail()
		}
		if (compression == 3 || compression == 6) && bitsPerPixel != 16 && bitsPerPixel != 32 {
			return fail()
		}
	}
	minimumOffset := headerEnd
	if bitsPerPixel <= 8 {
		paletteEntries := uint64(1) << bitsPerPixel
		if !coreHeader && colorsUsed != 0 {
			paletteEntries = uint64(colorsUsed)
			if paletteEntries > uint64(1)<<bitsPerPixel {
				return fail()
			}
		}
		entryBytes := uint64(4)
		if coreHeader {
			entryBytes = 3
		}
		minimumOffset += paletteEntries * entryBytes
	} else if colorsUsed != 0 {
		minimumOffset += uint64(colorsUsed) * 4
	}
	if !coreHeader && (compression == 3 || compression == 6) {
		neededMasks := uint64(12)
		if compression == 6 {
			neededMasks = 16
		}
		includedMasks := uint64(0)
		if dibSize >= 52 {
			includedMasks = 12
		}
		if dibSize >= 56 {
			includedMasks = 16
		}
		if neededMasks > includedMasks {
			minimumOffset += neededMasks - includedMasks
		}
	}
	if pixelOffset < minimumOffset || pixelOffset > uint64(len(data)) {
		return fail()
	}
	payloadBytes := uint64(len(data)) - pixelOffset
	if coreHeader || compression == 0 || compression == 3 || compression == 6 {
		rowBytes := ((uint64(width)*bitsPerPixel + 31) / 32) * 4
		requiredBytes := rowBytes * uint64(height)
		if payloadBytes < requiredBytes || imageSize != 0 && uint64(imageSize) < requiredBytes || imageSize != 0 && uint64(imageSize) > payloadBytes {
			return fail()
		}
	} else if imageSize == 0 || uint64(imageSize) > payloadBytes {
		return fail()
	}
	return int(width), int(height), nil
}

func notaloneImageDimensions(data []byte) (int, int, error) {
	if imageExtForData(data) == "bmp" {
		return notaloneBMPDimensions(data)
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return 0, 0, notaloneFailure("history_image_quality_unverified")
	}
	return config.Width, config.Height, nil
}

func notaloneVerifyOriginalImage(metadata notaloneOriginalImageMetadata, data []byte) (notaloneImageQualityProof, string, error) {
	proof := notaloneImageQualityProof{}
	fail := func() (notaloneImageQualityProof, string, error) {
		return proof, "", notaloneFailure("history_image_quality_unverified")
	}
	if !metadata.BigURLFound || !md5LikeRe.MatchString(metadata.MD5) || metadata.HDLength <= 0 || int64(len(data)) != metadata.HDLength ||
		(metadata.HDWidth == nil) != (metadata.HDHeight == nil) || len(data) == 0 || int64(len(data)) > notaloneImageMaxBytes {
		return fail()
	}
	ext := imageExtForData(data)
	mimeType := imageMIMEForExt(ext)
	switch mimeType {
	case "image/jpeg", "image/png", "image/gif", "image/bmp":
	default:
		return fail()
	}
	width, height, err := notaloneImageDimensions(data)
	if err != nil || width <= 0 || height <= 0 || width > notaloneImageMaxDimension || height > notaloneImageMaxDimension ||
		int64(width)*int64(height) > notaloneImageMaxPixelCount || metadata.HDWidth != nil &&
		(width != *metadata.HDWidth || height != *metadata.HDHeight) {
		return fail()
	}
	md5Sum := md5.Sum(data)
	if !strings.EqualFold(hex.EncodeToString(md5Sum[:]), metadata.MD5) {
		return fail()
	}
	sha := sha256.Sum256(data)
	proof = notaloneImageQualityProof{Kind: notaloneImageQualityProofKind, MessageMD5: metadata.MD5, HDLength: metadata.HDLength,
		HDWidth: metadata.HDWidth, HDHeight: metadata.HDHeight, BigImageURLFound: true, ResourceSize: metadata.HDLength,
		VerifiedBytes: int64(len(data)), VerifiedSHA256: hex.EncodeToString(sha[:]), ContentWidth: width, ContentHeight: height}
	return proof, mimeType, nil
}

func (h *notaloneHistorySession) openImage(ctx context.Context, request notaloneHistoryRequest) (notaloneImageOpenResponse, error) {
	failed := notaloneImageOpenResponse{}
	if h.selected == nil || h.selected.Account != request.Account || h.selected.Conversation != request.Conversation ||
		h.selected.SourceGeneration == "" || h.snapshotMode != "normal" && (h.tail == nil || h.tail.target.Descriptor != request.Target) {
		return failed, notaloneFailure("history_image_association_unverified")
	}
	if err := h.ensureMessageGuard(); err != nil {
		return failed, notaloneFailure("history_image_association_unverified")
	}
	localID, _ := strconv.ParseInt(request.LocalID, 10, 64)
	serverID, _ := strconv.ParseInt(request.ServerID, 10, 64)
	sentAt, _ := strconv.ParseInt(request.SentAt, 10, 64)
	if localID <= 0 || serverID == 0 || sentAt <= 0 || sentAt%1000 != 0 {
		return failed, notaloneFailure("history_image_association_unverified")
	}
	createTime := sentAt / 1000
	message, target, messageErr := h.openImageMessage(ctx, request, localID, serverID, createTime)
	if messageErr != nil {
		return failed, messageErr
	}
	imageXML, err := notaloneDecodeImageXML(message.content, message.contentType)
	if err != nil {
		return failed, err
	}
	metadata, err := notaloneParseOriginalImageXML(imageXML)
	if err != nil {
		return failed, err
	}
	resource, resourceGuard, err := h.findOriginalImageResource(ctx, message, metadata)
	if err != nil {
		return failed, err
	}
	resourceKeep := false
	defer func() {
		if !resourceKeep {
			_ = resourceGuard.Close()
		}
	}()
	imageData, sourceEnvelope, imageGuard, proof, mimeType, err := h.readOriginalImage(ctx, message, metadata, &resource)
	if err != nil {
		return failed, err
	}
	imageKeep := false
	defer func() {
		if !imageKeep {
			_ = imageGuard.Close()
		}
	}()
	if ctx.Err() != nil {
		return failed, notaloneFailure("history_image_read_failed")
	}
	if err = resourceGuard.Check(); err != nil || imageGuard.Check() != nil || h.messageGuard == nil || h.messageGuard.Check() != nil {
		return failed, notaloneFailure("history_image_source_changed")
	}
	resourceToken, err := notaloneNewImageToken()
	if err != nil {
		return failed, notaloneFailure("history_image_read_failed")
	}
	resourceFingerprint, err := resourceGuard.FileFingerprint(message.resourceDBPath)
	if err != nil {
		return failed, notaloneFailure("history_image_source_changed")
	}
	imageFingerprint, err := imageGuard.FileFingerprint(imageGuard.watches[len(imageGuard.watches)-1].path)
	if err != nil {
		return failed, notaloneFailure("history_image_source_changed")
	}
	resourceIdentityParts := []string{"wechat-image-resource-source-v2", target.SourceGeneration, resourceGuard.Fingerprint(), resourceFingerprint,
		imageGuard.Fingerprint(), imageFingerprint, "message", message.partition, message.tableInstance, strconv.FormatInt(message.localID, 10),
		strconv.FormatInt(message.serverID, 10), strconv.FormatInt(message.createTime, 10), "resource_info", strconv.FormatInt(resource.InfoID, 10),
		"cache_md5", resource.CacheMD5, "info_packed_length", strconv.FormatInt(resource.InfoPackedInfoLength, 10),
		"info_packed_sha256", resource.InfoPackedInfoSHA256, "verified_sha256", proof.VerifiedSHA256}
	for _, detail := range resource.MatchingDetails {
		resourceIdentityParts = append(resourceIdentityParts, "resource_detail", strconv.FormatInt(detail.ID, 10), strconv.FormatInt(detail.TypeRaw, 10),
			strconv.FormatInt(detail.Size, 10), strconv.FormatInt(detail.Status, 10), detail.DataIndex, strconv.FormatInt(detail.CreateTime, 10),
			strconv.FormatInt(detail.AccessTime, 10), strconv.FormatInt(detail.PackedInfoLength, 10), detail.PackedInfoSHA256)
	}
	resourceSourceGeneration := notaloneHash(resourceIdentityParts...)
	response := notaloneImageOpenResponse{
		Protocol: "wechat-original-image-v1", ResourceToken: resourceToken,
		SourceGeneration: target.SourceGeneration, ResourceSourceGeneration: resourceSourceGeneration,
		Target: target.Descriptor, Partition: request.Partition, Table: request.Table, LocalID: request.LocalID,
		ServerID: request.ServerID, SentAt: request.SentAt, ResourceTable: notaloneImageResourceTableID,
		ResourceID: strconv.FormatInt(resource.ID, 10), ResourceTypeRaw: resource.TypeRaw, VariantCode: resource.TypeRaw >> 16,
		Complete: true, Quality: "original", QualityProof: proof, Envelope: "plain", SourceEnvelope: sourceEnvelope,
		ExpectedBytes: int64(len(imageData)), ExpectedSHA256: proof.VerifiedSHA256, MimeType: mimeType,
	}
	opened := &notaloneOpenImage{metadata: response, data: imageData, digest: sha256.New(), guards: []*notaloneSourceGuard{resourceGuard, imageGuard}}
	h.imageMu.Lock()
	if h.openImages == nil {
		h.openImages = map[string]*notaloneOpenImage{}
	}
	if len(h.openImages) >= 2 {
		h.imageMu.Unlock()
		return failed, notaloneFailure("history_image_too_large")
	}
	h.openImages[resourceToken] = opened
	h.imageMu.Unlock()
	resourceKeep, imageKeep = true, true
	return response, nil
}

type notaloneSnapshotImageMessage struct {
	partition      string
	tableInstance  string
	localID        int64
	serverID       int64
	localType      int64
	createTime     int64
	content        []byte
	contentType    int64
	cacheMD5       string
	resourceDBPath string
}

func (h *notaloneHistorySession) openImageMessage(ctx context.Context, request notaloneHistoryRequest, localID, serverID, createTime int64) (notaloneSnapshotImageMessage, notaloneSnapshotTarget, error) {
	message := notaloneSnapshotImageMessage{}
	var snapshot *notaloneSnapshot
	var target notaloneSnapshotTarget
	var temporary bool
	if h.snapshot != nil && h.snapshotMode == "normal" {
		target = h.snapshot.Target()
		if target.Descriptor == request.Target {
			snapshot = h.snapshot
		}
	}
	if snapshot == nil && h.tail != nil && h.tail.target.Descriptor == request.Target {
		target = h.tail.target
		snapshot = h.tail.snapshot
		if snapshot == nil {
			if h.supportProfile == nil || h.inspected == nil {
				return message, target, notaloneFailure("history_image_association_unverified")
			}
			var err error
			snapshot, err = newNotaloneSnapshot(ctx, h.server, *h.selected, *h.inspected, *h.supportProfile)
			if err != nil || !notaloneSameSnapshotInstances(target, snapshot.Target()) {
				if snapshot != nil {
					_ = snapshot.Close()
				}
				return message, target, notaloneFailure("history_image_association_unverified")
			}
			temporary = true
		}
	}
	if snapshot == nil || target.Descriptor != request.Target || target.SourceGeneration != h.selected.SourceGeneration || snapshot.Check() != nil {
		if temporary && snapshot != nil {
			_ = snapshot.Close()
		}
		return message, target, notaloneFailure("history_image_association_unverified")
	}
	defer func() {
		if temporary {
			_ = snapshot.Close()
		}
	}()
	matched := -1
	for index, shard := range snapshot.shards {
		if shard.partition == request.Partition && shard.instance == request.Table {
			if matched >= 0 {
				return message, target, notaloneFailure("history_image_association_unverified")
			}
			matched = index
		}
	}
	if matched < 0 {
		return message, target, notaloneFailure("history_image_association_unverified")
	}
	snapshot.mu.Lock()
	defer snapshot.mu.Unlock()
	if snapshot.checkLocked() != nil || matched >= len(snapshot.shards) {
		return message, target, notaloneFailure("history_image_association_unverified")
	}
	shard := snapshot.shards[matched]
	query := "SELECT local_id,server_id,local_type,create_time,WCDB_CT_message_content AS image_content_type,CASE WHEN (local_type & 4294967295)=3 THEN CASE WHEN length(CAST(message_content AS BLOB))<=? THEN message_content ELSE NULL END ELSE NULL END AS image_xml,CASE WHEN (local_type & 4294967295)=3 THEN CASE WHEN length(CAST(packed_info_data AS BLOB))<=? THEN packed_info_data ELSE NULL END ELSE NULL END AS image_message_packed_info,CASE WHEN (local_type & 4294967295)=3 THEN length(CAST(packed_info_data AS BLOB)) ELSE 0 END AS image_message_packed_info_length FROM " + quoteIdent(snapshot.table) + " WHERE local_id=? LIMIT 2"
	rows, err := shard.reader.QueryBounded(ctx, 2, query, int64(notaloneImageXMLByteLimit), int64(notaloneImagePackedInfoByteLimit), localID)
	if err != nil || len(rows) != 1 {
		return message, target, notaloneFailure("history_image_association_unverified")
	}
	row := rows[0]
	rowLocalID, rowServerID := rowInt64(row, "local_id"), rowInt64(row, "server_id")
	rowType, rowCreateTime := rowInt64(row, "local_type"), rowInt64(row, "create_time")
	baseKind, _, _ := wxkind.Unpack(rowType)
	if rowLocalID != localID || rowServerID != serverID || rowCreateTime != createTime || baseKind != 3 {
		return message, target, notaloneFailure("history_image_association_unverified")
	}
	content := rowBytes(row, "image_xml")
	if len(content) == 0 {
		return message, target, notaloneFailure("history_image_metadata_invalid")
	}
	cacheMD5, validCacheMD5 := notaloneSinglePackedMD5(rowBytes(row, "image_message_packed_info"), rowInt64(row, "image_message_packed_info_length"))
	if !validCacheMD5 {
		return message, target, notaloneFailure("history_image_association_unverified")
	}
	resourcePath, err := h.server.validatedDBPath("message", "message_resource.db")
	if err != nil {
		return message, target, notaloneFailure("history_image_association_unverified")
	}
	message = notaloneSnapshotImageMessage{partition: shard.partition, tableInstance: shard.instance, localID: rowLocalID,
		serverID: rowServerID, localType: rowType, createTime: rowCreateTime, content: content,
		contentType: rowInt64(row, "image_content_type"), cacheMD5: cacheMD5, resourceDBPath: resourcePath}
	return message, target, nil
}

func (h *notaloneHistorySession) imageProcessIdentity() (notaloneProcessIdentity, error) {
	if h.messageGuard == nil {
		return notaloneProcessIdentity{}, notaloneFailure("history_image_source_changed")
	}
	h.messageGuard.mu.Lock()
	processes := append([]notaloneProcessIdentity(nil), h.messageGuard.processes...)
	h.messageGuard.mu.Unlock()
	if len(processes) != 1 {
		return notaloneProcessIdentity{}, notaloneFailure("history_image_source_changed")
	}
	current, err := readNotaloneProcessIdentity(processes[0].pid, processes[0].path)
	if err != nil || current != processes[0] {
		return notaloneProcessIdentity{}, notaloneFailure("history_image_source_changed")
	}
	return processes[0], nil
}

func (h *notaloneHistorySession) newImageGuard(directory string, files []string) (*notaloneSourceGuard, error) {
	guard, err := newNotaloneSourceGuard(directory, files)
	if err != nil {
		return nil, notaloneFailure("history_image_source_changed")
	}
	process, err := h.imageProcessIdentity()
	if err != nil || guard.WatchProcess(process) != nil || guard.StartMonitor() != nil || guard.Check() != nil {
		_ = guard.Close()
		return nil, notaloneFailure("history_image_source_changed")
	}
	return guard, nil
}

func (h *notaloneHistorySession) findOriginalImageResource(ctx context.Context, message notaloneSnapshotImageMessage, _ notaloneOriginalImageMetadata) (notaloneImageResourceRecord, *notaloneSourceGuard, error) {
	resource := notaloneImageResourceRecord{}
	resourcePath := message.resourceDBPath
	if filepath.Clean(resourcePath) != resourcePath || !filepath.IsAbs(resourcePath) {
		return resource, nil, notaloneFailure("history_image_association_unverified")
	}
	resourceGuard, err := h.newImageGuard(filepath.Dir(resourcePath), []string{resourcePath})
	if err != nil {
		return resource, nil, err
	}
	keep := false
	defer func() {
		if !keep {
			_ = resourceGuard.Close()
		}
	}()
	db, err := h.server.openDBNoRefresh("message", "message_resource.db")
	if err != nil {
		return resource, nil, notaloneFailure("history_image_association_unverified")
	}
	defer db.Close()
	if resourceGuard.Check() != nil {
		return resource, nil, notaloneFailure("history_image_source_changed")
	}
	infoQuery := `SELECT i.message_id,CASE WHEN length(CAST(i.packed_info AS BLOB))<=? THEN i.packed_info ELSE NULL END AS info_packed_info,length(CAST(i.packed_info AS BLOB)) AS info_packed_info_length FROM MessageResourceInfo i JOIN ChatName2Id c ON c.rowid=i.chat_id WHERE c.user_name=? AND i.message_local_type=? AND i.message_create_time=? AND i.message_local_id=? AND i.message_svr_id=? ORDER BY i.message_id DESC LIMIT 3`
	infoRows, err := db.QueryBounded(ctx, 3, infoQuery, int64(notaloneImagePackedInfoByteLimit), h.selected.Conversation, message.localType, message.createTime, message.localID, message.serverID)
	if err != nil || len(infoRows) != 1 {
		return resource, nil, notaloneFailure("history_image_association_unverified")
	}
	infoRow := infoRows[0]
	messageID := rowInt64(infoRow, "message_id")
	infoPackedInfo := rowBytes(infoRow, "info_packed_info")
	infoPackedLength := rowInt64(infoRow, "info_packed_info_length")
	cacheMD5, validCacheMD5 := notaloneSinglePackedMD5(infoPackedInfo, infoPackedLength)
	if messageID <= 0 || !validCacheMD5 || cacheMD5 != message.cacheMD5 {
		return resource, nil, notaloneFailure("history_image_association_unverified")
	}
	infoPackedSHA := sha256.Sum256(infoPackedInfo)
	detailQuery := `SELECT resource_id,type AS resource_type_raw,size AS resource_size,status AS resource_status,data_index AS resource_data_index,create_time AS resource_create_time,access_time AS resource_access_time,CASE WHEN length(CAST(packed_info AS BLOB))<=? THEN packed_info ELSE NULL END AS detail_packed_info,length(CAST(packed_info AS BLOB)) AS detail_packed_info_length FROM MessageResourceDetail WHERE message_id=? AND (type & 65535)=1 ORDER BY resource_id LIMIT 33`
	detailRows, err := db.QueryBounded(ctx, 33, detailQuery, int64(notaloneImagePackedInfoByteLimit), messageID)
	if err != nil || len(detailRows) == 0 || len(detailRows) > 32 {
		return resource, nil, notaloneFailure("history_image_association_unverified")
	}
	resource.InfoID = messageID
	resource.InfoPackedInfoLength = infoPackedLength
	resource.InfoPackedInfoSHA256 = hex.EncodeToString(infoPackedSHA[:])
	resource.CacheMD5 = cacheMD5
	var previousID int64
	for _, row := range detailRows {
		id, rawType := rowInt64(row, "resource_id"), rowInt64(row, "resource_type_raw")
		size := rowInt64(row, "resource_size")
		if id <= 0 || id <= previousID || rawType&0xffff != 1 || size <= 0 || size > notaloneImageSourceByteLimit {
			return notaloneImageResourceRecord{}, nil, notaloneFailure("history_image_association_unverified")
		}
		previousID = id
		packedLength := rowInt64(row, "detail_packed_info_length")
		packedInfo := rowBytes(row, "detail_packed_info")
		packedMD5Values, packedValid := notalonePackedMD5s(packedInfo, packedLength)
		packedMD5s := make([]string, 0, len(packedMD5Values))
		for value := range packedMD5Values {
			packedMD5s = append(packedMD5s, value)
		}
		packedDigest := ""
		if packedValid {
			sum := sha256.Sum256(packedInfo)
			packedDigest = hex.EncodeToString(sum[:])
		}
		resource.Details = append(resource.Details, notaloneImageResourceDetail{ID: id, TypeRaw: rawType, Size: size,
			Status: rowInt64(row, "resource_status"), DataIndex: rowString(row, "resource_data_index"),
			CreateTime: rowInt64(row, "resource_create_time"), AccessTime: rowInt64(row, "resource_access_time"),
			PackedInfoLength: packedLength, PackedInfoSHA256: packedDigest, PackedMD5s: packedMD5s, PackedInfoValid: packedValid})
	}
	if resourceGuard.Check() != nil {
		return notaloneImageResourceRecord{}, nil, notaloneFailure("history_image_source_changed")
	}
	keep = true
	return resource, resourceGuard, nil
}

func (h *notaloneHistorySession) readOriginalImage(ctx context.Context, message notaloneSnapshotImageMessage, metadata notaloneOriginalImageMetadata, resource *notaloneImageResourceRecord) ([]byte, string, *notaloneSourceGuard, notaloneImageQualityProof, string, error) {
	var emptyProof notaloneImageQualityProof
	if resource == nil || resource.InfoID <= 0 || resource.CacheMD5 == "" || len(resource.Details) == 0 {
		return nil, "", nil, emptyProof, "", notaloneFailure("history_image_association_unverified")
	}
	month := time.Unix(message.createTime, 0).Format("2006-01")
	baseDir := filepath.Join(h.server.cfg.DBRoot, "msg", "attach", talkerHash(h.selected.Conversation), month, "Img")
	type verifiedCandidate struct {
		data     []byte
		envelope string
		guard    *notaloneSourceGuard
		proof    notaloneImageQualityProof
		mimeType string
		record   notaloneImageResourceDetail
		matching []notaloneImageResourceDetail
	}
	var verified []verifiedCandidate
	var foundCandidate, foundAssociation, associationUnverified, qualityUnverified, keyUnavailable bool
	for _, suffix := range []string{".dat", "_h.dat"} {
		if err := ctx.Err(); err != nil {
			for _, candidate := range verified {
				_ = candidate.guard.Close()
			}
			return nil, "", nil, emptyProof, "", notaloneFailure("history_image_read_failed")
		}
		candidate := filepath.Join(baseDir, resource.CacheMD5+suffix)
		guard, resolved, err := h.guardImageCandidate(candidate)
		if err != nil {
			if err.Error() == "history_image_source_changed" {
				for _, candidate := range verified {
					_ = candidate.guard.Close()
				}
				return nil, "", nil, emptyProof, "", err
			}
			continue
		}
		foundCandidate = true
		data, err := readNotaloneImageFile(resolved)
		if err != nil {
			_ = guard.Close()
			switch err.Error() {
			case "history_image_source_changed", "history_image_read_failed":
				for _, candidate := range verified {
					_ = candidate.guard.Close()
				}
				return nil, "", nil, emptyProof, "", err
			case "history_image_local_file_missing":
				foundCandidate = false
			default:
				qualityUnverified = true
			}
			continue
		}
		matching := make([]notaloneImageResourceDetail, 0, len(resource.Details))
		var candidateAssociationInvalid bool
		for _, detail := range resource.Details {
			if detail.Size != int64(len(data)) {
				continue
			}
			foundAssociation = true
			if !detail.PackedInfoValid || len(detail.PackedMD5s) > 1 || len(detail.PackedMD5s) == 1 && detail.PackedMD5s[0] != resource.CacheMD5 {
				candidateAssociationInvalid = true
				break
			}
			matching = append(matching, detail)
		}
		if candidateAssociationInvalid || len(matching) == 0 {
			associationUnverified = true
			_ = guard.Close()
			continue
		}
		decoded, envelope, err := notaloneDecodeLocalImage(data, h.server.cfg)
		if err != nil {
			_ = guard.Close()
			if err.Error() == "history_image_key_unavailable" {
				keyUnavailable = true
			} else {
				qualityUnverified = true
			}
			continue
		}
		proof, mimeType, err := notaloneVerifyOriginalImage(metadata, decoded)
		if err != nil {
			_ = guard.Close()
			qualityUnverified = true
			continue
		}
		if guard.Check() != nil {
			_ = guard.Close()
			for _, candidate := range verified {
				_ = candidate.guard.Close()
			}
			return nil, "", nil, emptyProof, "", notaloneFailure("history_image_source_changed")
		}
		proof.ResourceInfoID = strconv.FormatInt(resource.InfoID, 10)
		proof.MatchingResourceIDs = make([]string, 0, len(matching))
		for _, detail := range matching {
			proof.MatchingResourceIDs = append(proof.MatchingResourceIDs, strconv.FormatInt(detail.ID, 10))
		}
		proof.ResourceSize = int64(len(data))
		verified = append(verified, verifiedCandidate{data: decoded, envelope: envelope, guard: guard, proof: proof,
			mimeType: mimeType, record: matching[0], matching: matching})
	}
	if len(verified) > 1 {
		for _, candidate := range verified[1:] {
			if !bytes.Equal(verified[0].data, candidate.data) {
				for _, accepted := range verified {
					_ = accepted.guard.Close()
				}
				return nil, "", nil, emptyProof, "", notaloneFailure("history_image_quality_unverified")
			}
		}
	}
	if len(verified) > 0 {
		selected := verified[0]
		for _, candidate := range verified[1:] {
			_ = candidate.guard.Close()
		}
		resource.ID, resource.TypeRaw, resource.Size, resource.Status = selected.record.ID, selected.record.TypeRaw, selected.record.Size, selected.record.Status
		resource.DataIndex, resource.CreateTime, resource.AccessTime = selected.record.DataIndex, selected.record.CreateTime, selected.record.AccessTime
		resource.PackedInfoLength, resource.PackedInfoSHA256 = selected.record.PackedInfoLength, selected.record.PackedInfoSHA256
		resource.MatchingDetails = selected.matching
		return selected.data, selected.envelope, selected.guard, selected.proof, selected.mimeType, nil
	}
	if keyUnavailable {
		return nil, "", nil, emptyProof, "", notaloneFailure("history_image_key_unavailable")
	}
	if associationUnverified || foundCandidate && !foundAssociation {
		return nil, "", nil, emptyProof, "", notaloneFailure("history_image_association_unverified")
	}
	if qualityUnverified {
		return nil, "", nil, emptyProof, "", notaloneFailure("history_image_quality_unverified")
	}
	if foundCandidate {
		return nil, "", nil, emptyProof, "", notaloneFailure("history_image_quality_unverified")
	}
	return nil, "", nil, emptyProof, "", notaloneFailure("history_image_local_file_missing")
}

func (h *notaloneHistorySession) guardImageCandidate(candidate string) (*notaloneSourceGuard, string, error) {
	var none *notaloneSourceGuard
	if !filepath.IsAbs(candidate) || filepath.Clean(candidate) != candidate {
		return none, "", notaloneFailure("history_image_quality_unverified")
	}
	attachRoot := filepath.Join(h.server.cfg.DBRoot, "msg", "attach")
	resolvedRoot, err := filepath.EvalSymlinks(attachRoot)
	if err != nil {
		return none, "", notaloneFailure("history_image_local_file_missing")
	}
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		if os.IsNotExist(err) {
			return none, "", notaloneFailure("history_image_local_file_missing")
		}
		return none, "", notaloneFailure("history_image_quality_unverified")
	}
	lexicalRel, err := filepath.Rel(attachRoot, candidate)
	if err != nil || lexicalRel == "." || filepath.IsAbs(lexicalRel) || strings.HasPrefix(lexicalRel, ".."+string(filepath.Separator)) || lexicalRel == ".." {
		return none, "", notaloneFailure("history_image_quality_unverified")
	}
	if resolved != filepath.Join(resolvedRoot, lexicalRel) {
		return none, "", notaloneFailure("history_image_quality_unverified")
	}
	info, err := os.Lstat(candidate)
	if err != nil {
		if os.IsNotExist(err) {
			return none, "", notaloneFailure("history_image_local_file_missing")
		}
		return none, "", notaloneFailure("history_image_quality_unverified")
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return none, "", notaloneFailure("history_image_quality_unverified")
	}
	guard, err := h.newImageGuard(filepath.Dir(resolved), []string{resolved})
	if err != nil {
		return none, "", err
	}
	return guard, resolved, nil
}

func readNotaloneImageFile(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, notaloneFailure("history_image_local_file_missing")
		}
		return nil, notaloneFailure("history_image_read_failed")
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > notaloneImageSourceByteLimit {
		return nil, notaloneFailure("history_image_quality_unverified")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, notaloneFailure("history_image_read_failed")
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) || opened.Size() != info.Size() {
		return nil, notaloneFailure("history_image_source_changed")
	}
	data, err := io.ReadAll(io.LimitReader(file, notaloneImageSourceByteLimit+1))
	if err != nil {
		return nil, notaloneFailure("history_image_read_failed")
	}
	if int64(len(data)) != opened.Size() || int64(len(data)) > notaloneImageSourceByteLimit {
		return nil, notaloneFailure("history_image_quality_unverified")
	}
	return data, nil
}

func notaloneDecodeLocalImage(data []byte, cfg *config.Config) ([]byte, string, error) {
	if len(data) == 0 || int64(len(data)) > notaloneImageSourceByteLimit {
		return nil, "", notaloneFailure("history_image_quality_unverified")
	}
	if mime := imageMIMEForExt(imageExtForData(data)); mime != "" {
		return data, "plain", nil
	}
	if bytes.HasPrefix(data, wechatV4ImageHeader1) || bytes.HasPrefix(data, wechatV4ImageHeader2) {
		if cfg == nil || cfg.ImageXORKey == nil || *cfg.ImageXORKey < 0 || *cfg.ImageXORKey > 255 {
			return nil, "", notaloneFailure("history_image_key_unavailable")
		}
		var aesKey []byte
		if bytes.HasPrefix(data, wechatV4ImageHeader1) {
			aesKey = wechatV4FixedAESKey
		} else {
			aesKey = notaloneConfiguredImageAESKey(cfg.ImageKey)
			if len(aesKey) != 16 {
				return nil, "", notaloneFailure("history_image_key_unavailable")
			}
		}
		decoded, err := decodeWechatV4ImageData(data, aesKey, byte(*cfg.ImageXORKey))
		if err != nil || imageMIMEForExt(imageExtForData(decoded)) == "" {
			return nil, "", notaloneFailure("history_image_quality_unverified")
		}
		return decoded, "wechat_dat", nil
	}
	if decoded, _, ok := decodeWechatV3XORImage(data); ok {
		if imageMIMEForExt(imageExtForData(decoded)) != "" {
			return decoded, "wechat_dat", nil
		}
	}
	return nil, "", notaloneFailure("history_image_quality_unverified")
}

func notaloneConfiguredImageAESKey(value string) []byte {
	value = strings.TrimSpace(value)
	if len(value) == 32 {
		decoded, err := hex.DecodeString(value)
		if err == nil && len(decoded) == 16 {
			return decoded
		}
	}
	if len(value) == 16 {
		return []byte(value)
	}
	return nil
}

func notaloneNewImageToken() (string, error) {
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return "", notaloneFailure("history_image_read_failed")
	}
	return base64.RawURLEncoding.EncodeToString(random), nil
}

func (h *notaloneHistorySession) readImage(ctx context.Context, token string, offset int64) (notaloneImageReadResponse, error) {
	response := notaloneImageReadResponse{}
	if ctx.Err() != nil {
		return response, notaloneFailure("history_image_read_failed")
	}
	h.imageMu.Lock()
	opened := h.openImages[token]
	if opened == nil {
		h.imageMu.Unlock()
		return response, notaloneFailure("history_image_token_invalid")
	}
	if offset != opened.next || offset < 0 || offset > int64(len(opened.data)) {
		h.imageMu.Unlock()
		return response, notaloneFailure("history_image_offset_invalid")
	}
	if h.messageGuard == nil || h.messageGuard.Check() != nil {
		delete(h.openImages, token)
		h.imageMu.Unlock()
		opened.close()
		return response, notaloneFailure("history_image_source_changed")
	}
	for _, guard := range opened.guards {
		if guard.Check() != nil {
			delete(h.openImages, token)
			h.imageMu.Unlock()
			opened.close()
			return response, notaloneFailure("history_image_source_changed")
		}
	}
	end := offset + notaloneImageChunkBytes
	if end > int64(len(opened.data)) {
		end = int64(len(opened.data))
	}
	chunk := opened.data[offset:end]
	if _, err := opened.digest.Write(chunk); err != nil {
		delete(h.openImages, token)
		h.imageMu.Unlock()
		opened.close()
		return response, notaloneFailure("history_image_read_failed")
	}
	opened.next = end
	eof := end == int64(len(opened.data))
	verified := ""
	if eof {
		verified = hex.EncodeToString(opened.digest.Sum(nil))
		if verified != opened.metadata.ExpectedSHA256 {
			delete(h.openImages, token)
			h.imageMu.Unlock()
			opened.close()
			return response, notaloneFailure("history_image_source_changed")
		}
	}
	if ctx.Err() != nil {
		delete(h.openImages, token)
		h.imageMu.Unlock()
		opened.close()
		return response, notaloneFailure("history_image_read_failed")
	}
	response = notaloneImageReadResponse{ResourceToken: token, SourceGeneration: opened.metadata.SourceGeneration,
		Offset: offset, BytesRead: int64(len(chunk)), TotalBytes: int64(len(opened.data)),
		ChunkBase64: base64.StdEncoding.EncodeToString(chunk), EOF: eof, VerifiedSHA256: verified}
	h.imageMu.Unlock()
	if eof {
		_ = h.closeImage(token)
	}
	return response, nil
}

func (opened *notaloneOpenImage) close() {
	if opened == nil {
		return
	}
	for _, guard := range opened.guards {
		_ = guard.Close()
	}
	opened.guards = nil
	opened.data = nil
}

func (h *notaloneHistorySession) closeImage(token string) notaloneImageCloseResponse {
	h.imageMu.Lock()
	opened := h.openImages[token]
	delete(h.openImages, token)
	h.imageMu.Unlock()
	if opened != nil {
		opened.close()
	}
	return notaloneImageCloseResponse{Closed: true}
}

func (h *notaloneHistorySession) closeAllImages() {
	h.imageMu.Lock()
	images := h.openImages
	h.openImages = nil
	h.imageMu.Unlock()
	for _, opened := range images {
		opened.close()
	}
}
