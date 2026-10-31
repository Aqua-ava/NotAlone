package main

import (
	"bytes"
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/r266-tech/wx-cli/v2/internal/wcdb"
)

func notaloneTinyPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.Set(x, y, color.RGBA{R: uint8(40 + x), G: uint8(80 + y), B: 120, A: 255})
		}
	}
	var data bytes.Buffer
	if err := png.Encode(&data, img); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func notaloneTinyBMPDIBHeader(t *testing.T, dibSize uint32, width, signedHeight int32) []byte {
	t.Helper()
	height := int64(signedHeight)
	if height < 0 {
		height = -height
	}
	rowBytes := ((int64(width)*24 + 31) / 32) * 4
	pixelBytes := rowBytes * height
	fileHeaderBytes := int64(14)
	if dibSize == 12 {
		fileHeaderBytes += 12
	} else {
		fileHeaderBytes += int64(dibSize)
	}
	data := make([]byte, fileHeaderBytes+pixelBytes)
	copy(data[:2], "BM")
	binary.LittleEndian.PutUint32(data[2:6], uint32(len(data)))
	binary.LittleEndian.PutUint32(data[10:14], uint32(fileHeaderBytes))
	binary.LittleEndian.PutUint32(data[14:18], dibSize)
	if dibSize == 12 {
		binary.LittleEndian.PutUint16(data[18:20], uint16(width))
		binary.LittleEndian.PutUint16(data[20:22], uint16(signedHeight))
		binary.LittleEndian.PutUint16(data[22:24], 1)
		binary.LittleEndian.PutUint16(data[24:26], 24)
	} else {
		binary.LittleEndian.PutUint32(data[18:22], uint32(width))
		binary.LittleEndian.PutUint32(data[22:26], uint32(signedHeight))
		binary.LittleEndian.PutUint16(data[26:28], 1)
		binary.LittleEndian.PutUint16(data[28:30], 24)
		binary.LittleEndian.PutUint32(data[34:38], uint32(pixelBytes))
	}
	return data
}

func notaloneTinyBMPRLE8(t *testing.T, signedHeight int32) []byte {
	t.Helper()
	const width int64 = 2
	const dibSize = uint32(40)
	const paletteBytes = 256 * 4
	const pixelOffset = 14 + dibSize + paletteBytes
	pixels := []byte{2, 1, 0, 0, 0, 1}
	data := make([]byte, int(pixelOffset)+len(pixels))
	copy(data[:2], "BM")
	binary.LittleEndian.PutUint32(data[2:6], uint32(len(data)))
	binary.LittleEndian.PutUint32(data[10:14], pixelOffset)
	binary.LittleEndian.PutUint32(data[14:18], dibSize)
	binary.LittleEndian.PutUint32(data[18:22], uint32(width))
	binary.LittleEndian.PutUint32(data[22:26], uint32(signedHeight))
	binary.LittleEndian.PutUint16(data[26:28], 1)
	binary.LittleEndian.PutUint16(data[28:30], 8)
	binary.LittleEndian.PutUint32(data[30:34], 1)
	binary.LittleEndian.PutUint32(data[34:38], uint32(len(pixels)))
	copy(data[pixelOffset:], pixels)
	return data
}

func notaloneImageXML(data []byte, hdLength int, width, height int, bigURL bool) string {
	sum := md5.Sum(data)
	big := ""
	if bigURL {
		big = ` cdnbigimgurl="local-source-only"`
	}
	return fmt.Sprintf(`<msg><img md5="%s" length="%d" hdlength="%d" cdnhdwidth="%d" cdnhdheight="%d"%s /></msg>`,
		hex.EncodeToString(sum[:]), len(data), hdLength, width, height, big)
}

func TestNotAloneOriginalImageProofRequiresExplicitHighDefinitionXML(t *testing.T) {
	data := notaloneTinyPNG(t, 3, 2)
	meta, err := notaloneParseOriginalImageXML([]byte(notaloneImageXML(data, len(data), 3, 2, true)))
	if err != nil {
		t.Fatal(err)
	}
	proof, mimeType, err := notaloneVerifyOriginalImage(meta, data)
	if err != nil || mimeType != "image/png" || proof.Kind != "wechat-cdn-big-hd-exact-content-v1" ||
		proof.HDLength != int64(len(data)) || proof.HDWidth != 3 || proof.HDHeight != 2 ||
		proof.VerifiedBytes != int64(len(data)) || proof.VerifiedSHA256 != fmt.Sprintf("%x", sha256.Sum256(data)) {
		t.Fatalf("strict original-image proof mismatch: proof=%#v mime=%q err=%v", proof, mimeType, err)
	}

	// 一个与候选图完全相同的普通显示图仍不能升级为原图：XML 没有 big/HD 证据。
	for _, xml := range []string{
		notaloneImageXML(data, len(data), 3, 2, false),
		notaloneImageXML(data, 0, 3, 2, true),
		notaloneImageXML(data, len(data), 0, 2, true),
		notaloneImageXML(data, len(data), 3, 0, true),
	} {
		meta, parseErr := notaloneParseOriginalImageXML([]byte(xml))
		if parseErr == nil {
			if _, _, verifyErr := notaloneVerifyOriginalImage(meta, data); verifyErr == nil {
				t.Fatal("普通显示图、缺hdlength或缺HD尺寸不能证明原图")
			}
		}
	}
	meta, err = notaloneParseOriginalImageXML([]byte(notaloneImageXML(data, len(data), 3, 2, true)))
	if err != nil {
		t.Fatal(err)
	}
	wrong := append([]byte(nil), data...)
	wrong[len(wrong)-1] ^= 1
	if _, _, err = notaloneVerifyOriginalImage(meta, wrong); err == nil {
		t.Fatal("XML MD5 与候选字节不符时不能证明原图")
	}
	if _, _, err = notaloneVerifyOriginalImage(meta, notaloneTinyPNG(t, 2, 3)); err == nil {
		t.Fatal("HD像素尺寸不符时不能证明原图")
	}
}

type notaloneImageProtocolFixture struct {
	history *notaloneHistorySession
	request notaloneHistoryRequest
	image   []byte
	path    string
}

func newNotaloneImageProtocolFixture(t *testing.T, imageXML string) notaloneImageProtocolFixture {
	return newNotaloneImageProtocolFixtureWithImage(t, imageXML, notaloneTinyPNG(t, 3, 2))
}

func newNotaloneImageProtocolFixtureWithImage(t *testing.T, imageXML string, imageBytes []byte) notaloneImageProtocolFixture {
	t.Helper()
	h := notaloneProtocolFixture(t, true)
	const localID, serverID, createTime = int64(1), int64(7710666891970547832), int64(1700000000)
	writer, err := wcdb.OpenWithKeyMapWritable(filepath.Join(h.server.cfg.DBRoot, "db_storage/message/message_0.db"), h.server.cfg.Keys)
	if err != nil {
		t.Fatal(err)
	}
	if err = writer.Exec(fmt.Sprintf(`UPDATE %s SET server_id=%d,local_type=3,create_time=%d,status=0,message_content='%s' WHERE local_id=%d`,
		quoteIdent("Msg_"+talkerHash(h.selected.Conversation)), serverID, createTime, strings.ReplaceAll(imageXML, "'", "''"), localID)); err != nil {
		writer.Close()
		t.Fatal(err)
	}
	writer.Close()

	// The resource DB remains an encrypted WCDB fixture; only this selected message is represented.
	md5Value := md5.Sum(imageBytes)
	packedMD5 := "12220A20" + hex.EncodeToString(md5Value[:])
	notaloneTestDB(t, h.server.cfg.DBRoot, h.server.cfg, "message", "message_resource.db",
		`CREATE TABLE ChatName2Id(user_name TEXT);INSERT INTO ChatName2Id(rowid,user_name) VALUES(1,'`+h.selected.Conversation+`');`+
			`CREATE TABLE MessageResourceInfo(message_id INTEGER,chat_id INTEGER,message_local_type INTEGER,message_create_time INTEGER,message_local_id INTEGER,message_svr_id INTEGER,message_origin_source INTEGER,packed_info BLOB);`+
			`INSERT INTO MessageResourceInfo VALUES(5,1,3,1700000000,1,7710666891970547832,0,X'`+packedMD5+`');`+
			`CREATE TABLE MessageResourceDetail(resource_id INTEGER,message_id INTEGER,type INTEGER,size INTEGER,create_time INTEGER,access_time INTEGER,status INTEGER,data_index TEXT,packed_info BLOB);`+
			`INSERT INTO MessageResourceDetail VALUES(11,5,65537,`+fmt.Sprint(len(imageBytes))+`,1700000000,1700000000,1,'0',X'`+packedMD5+`');`,
		strings.Repeat("66", 16))
	configFile := os.Getenv("WECHAT_CLI_CONFIG")
	data, err := json.Marshal(h.server.cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(configFile, data, 0600); err != nil {
		t.Fatal(err)
	}

	month := time.Unix(createTime, 0).Format("2006-01")
	path := filepath.Join(h.server.cfg.DBRoot, "msg", "attach", talkerHash(h.selected.Conversation), month, "Img", fmt.Sprintf("%x.dat", md5Value))
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, imageBytes, 0600); err != nil {
		t.Fatal(err)
	}

	common := notaloneHistoryRequest{Account: h.selected.Account, Conversation: h.selected.Conversation}
	if _, err = h.handle(context.Background(), notaloneHistoryRequest{Operation: "support", Account: common.Account, Conversation: common.Conversation, Consent: "selected-schema-v1"}); err != nil {
		t.Fatal(err)
	}
	value, err := h.handle(context.Background(), notaloneHistoryRequest{Operation: "target", Account: common.Account, Conversation: common.Conversation, Consent: "selected-history-v1"})
	if err != nil {
		t.Fatal(err)
	}
	target := value.(notaloneSnapshotTarget)
	if len(target.Tables) != 1 {
		t.Fatalf("synthetic selected target should have one shard/table, got %d", len(target.Tables))
	}
	return notaloneImageProtocolFixture{history: h, image: imageBytes, path: path, request: notaloneHistoryRequest{
		Operation: "image-open", Account: common.Account, Conversation: common.Conversation, Consent: "selected-image-v1",
		Target: target.Descriptor, Partition: target.Tables[0].Partition, Table: target.Tables[0].Instance,
		LocalID: fmt.Sprint(localID), ServerID: fmt.Sprint(serverID), SentAt: fmt.Sprint(createTime * 1000),
	}}
}

func TestNotAloneImageOpenStreamsOnlyVerifiedOriginalFromSelectedSnapshot(t *testing.T) {
	imageBytes := notaloneTinyPNG(t, 3, 2)
	fixture := newNotaloneImageProtocolFixture(t, notaloneImageXML(imageBytes, len(imageBytes), 3, 2, true))
	value, err := fixture.history.handle(context.Background(), fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	opened, ok := value.(notaloneImageOpenResponse)
	if !ok || !opened.Complete || opened.Quality != "original" || opened.Envelope != "plain" || opened.SourceEnvelope != "plain" ||
		opened.ExpectedBytes != int64(len(imageBytes)) || opened.ExpectedSHA256 != fmt.Sprintf("%x", sha256.Sum256(imageBytes)) ||
		opened.LocalID != fixture.request.LocalID || opened.ServerID != fixture.request.ServerID || opened.Target != fixture.request.Target ||
		opened.Partition != fixture.request.Partition || opened.Table != fixture.request.Table || opened.ResourceID != "11" {
		t.Fatalf("verified image open metadata mismatch: %#v", value)
	}
	encoded, err := json.Marshal(opened)
	if err != nil || strings.Contains(string(encoded), fixture.history.server.cfg.DBRoot) || strings.Contains(string(encoded), "message_content") || strings.Contains(string(encoded), "cdnBigImageUrl") {
		t.Fatalf("image protocol exposed an internal path or message XML: %s", encoded)
	}
	chunkValue, err := fixture.history.handle(context.Background(), notaloneHistoryRequest{Operation: "image-read", ResourceToken: opened.ResourceToken, Offset: 0})
	if err != nil {
		t.Fatal(err)
	}
	chunk := chunkValue.(notaloneImageReadResponse)
	decoded, err := base64.StdEncoding.DecodeString(chunk.ChunkBase64)
	if err != nil || !bytes.Equal(decoded, imageBytes) || !chunk.EOF || chunk.VerifiedSHA256 != opened.ExpectedSHA256 {
		t.Fatalf("image stream failed byte/digest verification: chunk=%#v err=%v", chunk, err)
	}
	closed, err := fixture.history.handle(context.Background(), notaloneHistoryRequest{Operation: "image-close", ResourceToken: opened.ResourceToken})
	if err != nil || !closed.(notaloneImageCloseResponse).Closed {
		t.Fatalf("image token did not close: value=%#v err=%v", closed, err)
	}
}

func TestNotAloneImageOpenStreamsBMPOriginalFromTopDownInfoHeader(t *testing.T) {
	imageBytes := notaloneTinyBMPDIBHeader(t, 40, 2, -2)
	width, height, err := notaloneBMPDimensions(imageBytes)
	if err != nil || width != 2 || height != 2 {
		t.Fatalf("valid top-down BMP dimensions were not read: %dx%d err=%v", width, height, err)
	}
	fixture := newNotaloneImageProtocolFixtureWithImage(t, notaloneImageXML(imageBytes, len(imageBytes), 2, 2, true), imageBytes)
	value, err := fixture.history.handle(context.Background(), fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	opened, ok := value.(notaloneImageOpenResponse)
	if !ok || opened.MimeType != "image/bmp" || opened.Quality != "original" || opened.ExpectedBytes != int64(len(imageBytes)) {
		t.Fatalf("valid standard top-down BMP was not verified as original: %#v", value)
	}
	chunkValue, err := fixture.history.handle(context.Background(), notaloneHistoryRequest{Operation: "image-read", ResourceToken: opened.ResourceToken, Offset: 0})
	if err != nil {
		t.Fatal(err)
	}
	chunk := chunkValue.(notaloneImageReadResponse)
	decoded, err := base64.StdEncoding.DecodeString(chunk.ChunkBase64)
	if err != nil || !bytes.Equal(decoded, imageBytes) || !chunk.EOF {
		t.Fatalf("BMP resource did not stream unchanged: err=%v eof=%t", err, chunk.EOF)
	}
}

func TestNotAloneOriginalImageProofAcceptsStandardBMPDIBHeaders(t *testing.T) {
	for _, dibSize := range []uint32{12, 40, 52, 56, 64, 108, 124} {
		t.Run(fmt.Sprint(dibSize), func(t *testing.T) {
			data := notaloneTinyBMPDIBHeader(t, dibSize, 2, 2)
			metadata, err := notaloneParseOriginalImageXML([]byte(notaloneImageXML(data, len(data), 2, 2, true)))
			if err != nil {
				t.Fatal(err)
			}
			if _, mimeType, err := notaloneVerifyOriginalImage(metadata, data); err != nil || mimeType != "image/bmp" {
				t.Fatalf("standard BMP DIB size %d should be recognized: mime=%q err=%v", dibSize, mimeType, err)
			}
		})
	}
}

func TestNotAloneBMPDimensionsRejectsMalformedLengthsAndUnboundedPixels(t *testing.T) {
	valid := notaloneTinyBMPDIBHeader(t, 40, 2, 2)
	truncatedPixels := append([]byte(nil), valid[:len(valid)-1]...)
	binary.LittleEndian.PutUint32(truncatedPixels[2:6], uint32(len(truncatedPixels)))
	binary.LittleEndian.PutUint32(truncatedPixels[34:38], 15)
	badDeclaredImageSize := append([]byte(nil), valid...)
	binary.LittleEndian.PutUint32(badDeclaredImageSize[34:38], 17)
	badFileSize := append([]byte(nil), valid...)
	binary.LittleEndian.PutUint32(badFileSize[2:6], uint32(len(badFileSize)+1))
	badDIBLength := append([]byte(nil), valid...)
	binary.LittleEndian.PutUint32(badDIBLength[14:18], 41)
	shortDIB := append([]byte(nil), valid...)
	binary.LittleEndian.PutUint32(shortDIB[14:18], 124)
	shortPixelOffset := append([]byte(nil), valid...)
	binary.LittleEndian.PutUint32(shortPixelOffset[10:14], 53)
	oversizedDimension := append([]byte(nil), valid...)
	binary.LittleEndian.PutUint32(oversizedDimension[18:22], 100001)
	tooManyPixels := append([]byte(nil), valid...)
	binary.LittleEndian.PutUint32(tooManyPixels[18:22], 100000)
	binary.LittleEndian.PutUint32(tooManyPixels[22:26], 1001)
	minimumHeight := append([]byte(nil), valid...)
	binary.LittleEndian.PutUint32(minimumHeight[22:26], 0x80000000)
	topDownRLE := notaloneTinyBMPRLE8(t, -2)

	for name, malformed := range map[string][]byte{
		"truncated pixels": truncatedPixels, "oversized image size": badDeclaredImageSize,
		"mismatched file size": badFileSize, "unknown DIB size": badDIBLength,
		"truncated DIB": shortDIB, "pixel offset inside headers": shortPixelOffset,
		"dimension over limit": oversizedDimension, "pixel count over limit": tooManyPixels,
		"minimum signed height": minimumHeight, "top-down RLE": topDownRLE,
	} {
		t.Run(name, func(t *testing.T) {
			if width, height, err := notaloneBMPDimensions(malformed); err == nil {
				t.Fatalf("malformed or unbounded BMP accepted as %dx%d", width, height)
			}
		})
	}
}

func TestNotAloneImageOpenRejectsCrossRecordIdentityAndUnverifiedThumbnail(t *testing.T) {
	imageBytes := notaloneTinyPNG(t, 3, 2)
	fixture := newNotaloneImageProtocolFixture(t, notaloneImageXML(imageBytes, len(imageBytes), 3, 2, true))
	wrong := fixture.request
	wrong.ServerID = "1"
	if _, err := fixture.history.handle(context.Background(), wrong); err == nil || err.Error() != "history_image_association_unverified" {
		t.Fatalf("resource row from another stable message must not attach: %v", err)
	}
	wrong = fixture.request
	wrong.Partition = strings.Repeat("0", 64)
	if _, err := fixture.history.handle(context.Background(), wrong); err == nil || err.Error() != "history_image_association_unverified" {
		t.Fatalf("foreign partition must not attach: %v", err)
	}
	meta, err := notaloneParseOriginalImageXML([]byte(notaloneImageXML(imageBytes, len(imageBytes), 3, 2, false)))
	if err == nil {
		_, _, err = notaloneVerifyOriginalImage(meta, imageBytes)
	}
	if err == nil {
		t.Fatal("same-sized ordinary display image must not be marked original")
	}
}
