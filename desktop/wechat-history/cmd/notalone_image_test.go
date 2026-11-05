package main

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/md5"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"math/rand"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"
	"github.com/r266-tech/wx-cli/v2/internal/wcdb"
)

func notaloneTinyPNG(t *testing.T, width, height int) []byte {
	return notaloneTinyPNGWithBaseColor(t, width, height, color.RGBA{R: 40, G: 80, B: 120, A: 255})
}

func notaloneTinyPNGWithBaseColor(t *testing.T, width, height int, base color.RGBA) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.Set(x, y, color.RGBA{R: base.R + uint8(x), G: base.G + uint8(y), B: base.B, A: base.A})
		}
	}
	var data bytes.Buffer
	if err := png.Encode(&data, img); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func notaloneTinyJPEG(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.Set(x, y, color.RGBA{R: uint8(20 + x), G: uint8(60 + y), B: 150, A: 255})
		}
	}
	var data bytes.Buffer
	if err := jpeg.Encode(&data, img, &jpeg.Options{Quality: 80}); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func notaloneTinyGIF(t *testing.T, width, height int) []byte {
	t.Helper()
	palette := color.Palette{color.RGBA{A: 255}, color.RGBA{R: 255, A: 255}}
	first := image.NewPaletted(image.Rect(0, 0, width, height), palette)
	second := image.NewPaletted(image.Rect(0, 0, width, height), palette)
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			first.SetColorIndex(x, y, uint8((x+y)%2))
			second.SetColorIndex(x, y, uint8((x+y+1)%2))
		}
	}
	var data bytes.Buffer
	if err := gif.EncodeAll(&data, &gif.GIF{Image: []*image.Paletted{first, second}, Delay: []int{0, 0}, LoopCount: 0}); err != nil {
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
	proofJSON, marshalErr := json.Marshal(proof)
	var proofWire map[string]any
	if marshalErr == nil {
		marshalErr = json.Unmarshal(proofJSON, &proofWire)
	}
	if err != nil || mimeType != "image/png" || proof.Kind != "wechat-cdn-big-hd-exact-content-v4" ||
		proof.HDLength != int64(len(data)) || marshalErr != nil || proofWire["hdWidth"] != float64(3) || proofWire["hdHeight"] != float64(2) ||
		proofWire["contentWidth"] != float64(3) || proofWire["contentHeight"] != float64(2) ||
		proof.VerifiedBytes != int64(len(data)) || proof.VerifiedSHA256 != fmt.Sprintf("%x", sha256.Sum256(data)) {
		t.Fatalf("strict original-image proof mismatch: proof=%#v mime=%q err=%v", proof, mimeType, err)
	}

	// 一个与候选图完全相同的普通显示图仍不能升级为原图：XML 没有 big/HD 证据。
	for _, xml := range []string{
		notaloneImageXML(data, len(data), 3, 2, false),
		notaloneImageXML(data, 0, 3, 2, true),
		notaloneImageXML(data, len(data), -1, 2, true),
		notaloneImageXML(data, len(data), 3, -1, true),
	} {
		meta, parseErr := notaloneParseOriginalImageXML([]byte(xml))
		if parseErr == nil {
			if _, _, verifyErr := notaloneVerifyOriginalImage(meta, data); verifyErr == nil {
				t.Fatal("普通显示图、缺hdlength或负HD尺寸不能证明原图")
			}
		}
	}
	zeroDimensions := notaloneImageXML(data, len(data), 0, 0, true)
	meta, err = notaloneParseOriginalImageXML([]byte(zeroDimensions))
	if err != nil {
		t.Fatalf("缺失HD尺寸不应抹掉其余原图证据: %v", err)
	}
	proof, _, err = notaloneVerifyOriginalImage(meta, data)
	proofJSON, marshalErr = json.Marshal(proof)
	proofWire = nil
	if marshalErr != nil || json.Unmarshal(proofJSON, &proofWire) != nil || err != nil || proofWire["hdWidth"] != nil ||
		proofWire["hdHeight"] != nil || proofWire["contentWidth"] != float64(3) || proofWire["contentHeight"] != float64(2) {
		t.Fatalf("应区分缺失的XML尺寸与实际内容尺寸: proof=%#v err=%v", proof, err)
	}
	oneDimensionMissing := strings.Replace(notaloneImageXML(data, len(data), 3, 2, true), ` cdnhdheight="2"`, "", 1)
	if _, err = notaloneParseOriginalImageXML([]byte(oneDimensionMissing)); err == nil {
		t.Fatal("只提供一侧HD尺寸时不能建立原图证明")
	}
	wrongDeclared := notaloneImageXML(data, len(data), 2, 2, true)
	meta, err = notaloneParseOriginalImageXML([]byte(wrongDeclared))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = notaloneVerifyOriginalImage(meta, data); err == nil {
		t.Fatal("显式声明的HD尺寸与内容不一致时必须拒绝")
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

type notaloneImageTestResourceDetail struct {
	id         int64
	typeRaw    int64
	size       int64
	packedInfo []byte
}

func newNotaloneImageProtocolFixture(t *testing.T, imageXML string) notaloneImageProtocolFixture {
	return newNotaloneImageProtocolFixtureWithImage(t, imageXML, notaloneTinyPNG(t, 3, 2))
}

func newNotaloneImageProtocolFixtureWithImage(t *testing.T, imageXML string, imageBytes []byte) notaloneImageProtocolFixture {
	return newNotaloneImageProtocolFixtureWithMessageContent(t, []byte(imageXML), 0, imageBytes)
}

func newNotaloneImageProtocolFixtureWithMessageContent(t *testing.T, messageContent []byte, contentType int64, imageBytes []byte) notaloneImageProtocolFixture {
	const cacheMD5 = "f71dbe52628a3f83a77ab494817525c6"
	detail := notaloneImageTestResourceDetail{id: 11, typeRaw: 65537, size: int64(len(imageBytes)), packedInfo: notaloneTestPackedInfo(cacheMD5)}
	return newNotaloneImageProtocolFixtureWithResourceData(t, messageContent, contentType, imageBytes, imageBytes,
		cacheMD5, notaloneTestPackedInfo(cacheMD5), notaloneTestPackedInfo(cacheMD5), []notaloneImageTestResourceDetail{detail})
}

func notaloneTestPackedInfo(md5Values ...string) []byte {
	var nested []byte
	for _, value := range md5Values {
		nested = append(nested, 0x0a, 0x20)
		nested = append(nested, []byte(value)...)
	}
	if len(nested) == 0 || len(nested) > 127 {
		return nil
	}
	return append([]byte{0x12, byte(len(nested))}, nested...)
}

func newNotaloneImageProtocolFixtureWithResourceData(t *testing.T, messageContent []byte, contentType int64, imageBytes, storageBytes []byte,
	cacheMD5 string, messagePackedInfo, infoPackedInfo []byte, details []notaloneImageTestResourceDetail) notaloneImageProtocolFixture {
	t.Helper()
	h := notaloneProtocolFixture(t, true)
	const localID, serverID, createTime = int64(1), int64(7710666891970547832), int64(1700000000)
	writer, err := wcdb.OpenWithKeyMapWritable(filepath.Join(h.server.cfg.DBRoot, "db_storage/message/message_0.db"), h.server.cfg.Keys)
	if err != nil {
		t.Fatal(err)
	}
	messageTable := quoteIdent("Msg_" + talkerHash(h.selected.Conversation))
	if err = writer.Exec(fmt.Sprintf(`ALTER TABLE %s ADD COLUMN WCDB_CT_message_content INTEGER`, messageTable)); err != nil {
		writer.Close()
		t.Fatal(err)
	}
	if err = writer.Exec(fmt.Sprintf(`ALTER TABLE %s ADD COLUMN packed_info_data BLOB`, messageTable)); err != nil {
		writer.Close()
		t.Fatal(err)
	}
	messageContentValue := fmt.Sprintf("X'%x'", messageContent)
	if len(messageContent) == 0 {
		messageContentValue = "NULL"
	}
	if err = writer.Exec(fmt.Sprintf(`UPDATE %s SET server_id=%d,local_type=3,create_time=%d,status=0,message_content=%s,WCDB_CT_message_content=%d,packed_info_data=X'%x' WHERE local_id=%d`,
		messageTable, serverID, createTime, messageContentValue, contentType, messagePackedInfo, localID)); err != nil {
		writer.Close()
		t.Fatal(err)
	}
	writer.Close()

	// The resource DB remains an encrypted WCDB fixture; only this selected message is represented.
	var resourceRows strings.Builder
	for _, detail := range details {
		resourceRows.WriteString(fmt.Sprintf(`INSERT INTO MessageResourceDetail VALUES(%d,5,%d,%d,1700000000,1700000000,1,'0',X'%x');`,
			detail.id, detail.typeRaw, detail.size, detail.packedInfo))
	}
	notaloneTestDB(t, h.server.cfg.DBRoot, h.server.cfg, "message", "message_resource.db",
		`CREATE TABLE ChatName2Id(user_name TEXT);INSERT INTO ChatName2Id(rowid,user_name) VALUES(1,'`+h.selected.Conversation+`');`+
			`CREATE TABLE MessageResourceInfo(message_id INTEGER,chat_id INTEGER,message_local_type INTEGER,message_create_time INTEGER,message_local_id INTEGER,message_svr_id INTEGER,message_origin_source INTEGER,packed_info BLOB);`+
			`INSERT INTO MessageResourceInfo VALUES(5,1,3,1700000000,1,7710666891970547832,0,X'`+hex.EncodeToString(infoPackedInfo)+`');`+
			`CREATE TABLE MessageResourceDetail(resource_id INTEGER,message_id INTEGER,type INTEGER,size INTEGER,create_time INTEGER,access_time INTEGER,status INTEGER,data_index TEXT,packed_info BLOB);`+
			resourceRows.String(),
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
	path := filepath.Join(h.server.cfg.DBRoot, "msg", "attach", talkerHash(h.selected.Conversation), month, "Img", cacheMD5+".dat")
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, storageBytes, 0600); err != nil {
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

func notaloneCompressImageXML(t *testing.T, raw []byte) []byte {
	t.Helper()
	encoder, err := zstd.NewWriter(nil, zstd.WithEncoderConcurrency(1))
	if err != nil {
		t.Fatal(err)
	}
	defer encoder.Close()
	return encoder.EncodeAll(raw, nil)
}

func notaloneTestV4ImageDAT(t *testing.T, key, plain []byte) []byte {
	t.Helper()
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	padding := aes.BlockSize - len(plain)%aes.BlockSize
	padded := append(append([]byte(nil), plain...), bytes.Repeat([]byte{byte(padding)}, padding)...)
	encrypted := make([]byte, len(padded))
	for offset := 0; offset < len(padded); offset += aes.BlockSize {
		block.Encrypt(encrypted[offset:offset+aes.BlockSize], padded[offset:offset+aes.BlockSize])
	}
	header := make([]byte, 15)
	copy(header, wechatV4ImageHeader2)
	binary.LittleEndian.PutUint32(header[6:10], uint32(len(plain)))
	header[14] = 1
	return append(header, encrypted...)
}

func TestNotAloneImageOpenBindsCacheKeyAndAliasesToVerifiedImageContent(t *testing.T) {
	imageBytes := notaloneTinyPNG(t, 3, 2)
	const cacheMD5 = "a71dbe52628a3f83a77ab494817525c6"
	key := []byte("0123456789abcdef")
	storage := notaloneTestV4ImageDAT(t, key, imageBytes)
	message := []byte(notaloneImageXML(imageBytes, len(imageBytes), 0, 0, true))
	packed := notaloneTestPackedInfo(cacheMD5)
	fixture := newNotaloneImageProtocolFixtureWithResourceData(t, message, 0, imageBytes, storage, cacheMD5, packed, packed,
		[]notaloneImageTestResourceDetail{
			{id: 7, typeRaw: 262145, size: int64(len(storage) - 1), packedInfo: notaloneTestPackedInfo("b71dbe52628a3f83a77ab494817525c6")},
			{id: 12, typeRaw: 131073, size: int64(len(storage)), packedInfo: packed},
			{id: 10, typeRaw: 65537, size: int64(len(storage)), packedInfo: packed},
		})
	xorKey := 0
	fixture.history.server.cfg.ImageKey = hex.EncodeToString(key)
	fixture.history.server.cfg.ImageXORKey = &xorKey

	value, err := fixture.history.handle(context.Background(), fixture.request)
	if err != nil {
		t.Fatalf("verified cache entity with V4 envelope and same-sized aliases should open: %v", err)
	}
	opened := value.(notaloneImageOpenResponse)
	proofJSON, err := json.Marshal(opened.QualityProof)
	if err != nil {
		t.Fatal(err)
	}
	var proof map[string]any
	if err = json.Unmarshal(proofJSON, &proof); err != nil {
		t.Fatal(err)
	}
	ids, _ := proof["matchingResourceIds"].([]any)
	if opened.Protocol != "wechat-original-image-v1" || opened.Quality != "original" ||
		opened.QualityProof.Kind != "wechat-message-image-content-v2" || opened.ResourceID != "10" ||
		opened.ResourceTypeRaw != 65537 || opened.SourceEnvelope != "wechat_dat" || opened.Envelope != "plain" ||
		proof["resourceInfoId"] != "5" || proof["resourceSize"] != float64(len(storage)) ||
		proof["verifiedBytes"] != float64(len(imageBytes)) || proof["sourceSha256"] != fmt.Sprintf("%x", sha256.Sum256(imageBytes)) ||
		proof["verifiedSha256"] != fmt.Sprintf("%x", sha256.Sum256(imageBytes)) || proof["conversion"] != "none" ||
		len(ids) != 2 || ids[0] != "10" || ids[1] != "12" {
		t.Fatalf("V4 stored bytes and matching detail aliases were not represented accurately: open=%#v proof=%s", opened, proofJSON)
	}
	if len(proof) != 13 {
		t.Fatalf("新证明必须包含完整来源、版本和可选原图内容依据, got %s", proofJSON)
	}
	chunkValue, err := fixture.history.handle(context.Background(), notaloneHistoryRequest{Operation: "image-read", ResourceToken: opened.ResourceToken, Offset: 0})
	if err != nil {
		t.Fatal(err)
	}
	chunk := chunkValue.(notaloneImageReadResponse)
	decoded, err := base64.StdEncoding.DecodeString(chunk.ChunkBase64)
	if err != nil || !bytes.Equal(decoded, imageBytes) || !chunk.EOF || chunk.VerifiedSHA256 != opened.ExpectedSHA256 {
		t.Fatalf("image stream did not return exact HD content: err=%v eof=%t", err, chunk.EOF)
	}
}

func TestNotAloneImageOpenDoesNotRequireOriginalImageXML(t *testing.T) {
	imageBytes := notaloneTinyPNG(t, 3, 2)
	for name, message := range map[string][]byte{
		"missing message content":  nil,
		"empty image attributes":   []byte(`<msg><img /></msg>`),
		"no original-image fields": []byte(`<msg><img md5="" hdlength="" cdnbigimgurl="" /></msg>`),
	} {
		t.Run(name, func(t *testing.T) {
			fixture := newNotaloneImageProtocolFixtureWithImage(t, string(message), imageBytes)
			value, err := fixture.history.handle(context.Background(), fixture.request)
			if err != nil {
				t.Fatalf("type 3 and packed-info association are sufficient without original-image XML: %v", err)
			}
			opened := value.(notaloneImageOpenResponse)
			if opened.Quality != "unknown" || opened.QualityProof.Kind != "wechat-message-image-content-v2" {
				t.Fatalf("decoded bytes must not claim original-image quality: %#v", opened)
			}
		})
	}
}

func TestNotAloneImageOpenRejectsUnprovenCacheIdentityAndSize(t *testing.T) {
	imageBytes := notaloneTinyPNG(t, 3, 2)
	const cacheMD5 = "a71dbe52628a3f83a77ab494817525c6"
	const otherMD5 = "b71dbe52628a3f83a77ab494817525c6"
	packed := notaloneTestPackedInfo(cacheMD5)
	validMessage := []byte(notaloneImageXML(imageBytes, len(imageBytes), 0, 0, true))
	cases := []struct {
		name          string
		message       []byte
		messagePacked []byte
		infoPacked    []byte
		details       []notaloneImageTestResourceDetail
		wantCode      string
	}{
		{name: "multiple message cache keys", message: validMessage, messagePacked: notaloneTestPackedInfo(cacheMD5, otherMD5), infoPacked: packed,
			details: []notaloneImageTestResourceDetail{{id: 11, typeRaw: 65537, size: int64(len(imageBytes)), packedInfo: packed}}, wantCode: "history_image_association_unverified"},
		{name: "multiple info cache keys", message: validMessage, messagePacked: packed, infoPacked: notaloneTestPackedInfo(cacheMD5, otherMD5),
			details: []notaloneImageTestResourceDetail{{id: 11, typeRaw: 65537, size: int64(len(imageBytes)), packedInfo: packed}}, wantCode: "history_image_association_unverified"},
		{name: "message and info keys differ", message: validMessage, messagePacked: notaloneTestPackedInfo(otherMD5), infoPacked: packed,
			details: []notaloneImageTestResourceDetail{{id: 11, typeRaw: 65537, size: int64(len(imageBytes)), packedInfo: packed}}, wantCode: "history_image_association_unverified"},
		{name: "no detail matches stored length", message: validMessage, messagePacked: packed, infoPacked: packed,
			details: []notaloneImageTestResourceDetail{{id: 11, typeRaw: 65537, size: int64(len(imageBytes) + 1), packedInfo: packed}}, wantCode: "history_image_association_unverified"},
		{name: "matching detail declares another cache key", message: validMessage, messagePacked: packed, infoPacked: packed,
			details: []notaloneImageTestResourceDetail{{id: 11, typeRaw: 65537, size: int64(len(imageBytes)), packedInfo: notaloneTestPackedInfo(otherMD5)}}, wantCode: "history_image_association_unverified"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			fixture := newNotaloneImageProtocolFixtureWithResourceData(t, test.message, 0, imageBytes, imageBytes, cacheMD5,
				test.messagePacked, test.infoPacked, test.details)
			if _, err := fixture.history.handle(context.Background(), fixture.request); err == nil || err.Error() != test.wantCode {
				t.Fatalf("unproven image resource should fail with %s, got %v", test.wantCode, err)
			}
		})
	}
}

func TestNotAloneImageOpenReportsMissingConfiguredV4Key(t *testing.T) {
	imageBytes := notaloneTinyPNG(t, 3, 2)
	const cacheMD5 = "a71dbe52628a3f83a77ab494817525c6"
	packed := notaloneTestPackedInfo(cacheMD5)
	storage := notaloneTestV4ImageDAT(t, []byte("0123456789abcdef"), imageBytes)
	fixture := newNotaloneImageProtocolFixtureWithResourceData(t, []byte(notaloneImageXML(imageBytes, len(imageBytes), 0, 0, true)), 0,
		imageBytes, storage, cacheMD5, packed, packed,
		[]notaloneImageTestResourceDetail{{id: 11, typeRaw: 65537, size: int64(len(storage)), packedInfo: packed}})
	if _, err := fixture.history.handle(context.Background(), fixture.request); err == nil || err.Error() != "history_image_key_unavailable" {
		t.Fatalf("encrypted local candidate without a configured key should be reported as unavailable, got %v", err)
	}
}

func TestNotAloneImageOpenDoesNotNeedToDecodeImageXML(t *testing.T) {
	imageBytes := notaloneTinyPNG(t, 3, 2)
	fixture := newNotaloneImageProtocolFixtureWithMessageContent(t, []byte(`<msg><img md5="not-an-md5" hdlength="1" cdnhdwidth="900" cdnhdheight="900" cdnbigimgurl="not-the-source" /></msg>`), 0, imageBytes)
	value, err := fixture.history.handle(context.Background(), fixture.request)
	if err != nil {
		t.Fatalf("mismatching original-image declarations must not block byte validation: %v", err)
	}
	opened := value.(notaloneImageOpenResponse)
	if opened.QualityProof.Kind != "wechat-message-image-content-v2" || opened.Quality != "unknown" ||
		opened.QualityProof.ContentWidth != 3 || opened.QualityProof.ContentHeight != 2 {
		t.Fatalf("unexpected content proof: %#v", opened.QualityProof)
	}
	chunkValue, err := fixture.history.handle(context.Background(), notaloneHistoryRequest{Operation: "image-read", ResourceToken: opened.ResourceToken, Offset: 0})
	if err != nil {
		t.Fatal(err)
	}
	chunk := chunkValue.(notaloneImageReadResponse)
	decoded, err := base64.StdEncoding.DecodeString(chunk.ChunkBase64)
	if err != nil || !bytes.Equal(decoded, imageBytes) || !chunk.EOF || chunk.VerifiedSHA256 != opened.ExpectedSHA256 {
		t.Fatalf("image stream failed content digest verification: err=%v eof=%t", err, chunk.EOF)
	}
}

func TestNotAloneImageOpenRejectsImageThatOnlyHasAValidHeader(t *testing.T) {
	valid := notaloneTinyPNG(t, 3, 2)
	// 保留 PNG 签名和完整 IHDR，使 DecodeConfig 能读出尺寸，但省略图像数据。
	truncated := append([]byte(nil), valid[:33]...)
	fixture := newNotaloneImageProtocolFixtureWithImage(t, `<msg><img /></msg>`, truncated)
	if _, err := fixture.history.handle(context.Background(), fixture.request); err == nil || err.Error() != "history_image_quality_unverified" {
		t.Fatalf("image must fail when only its format header and dimensions decode, got %v", err)
	}
}

func TestNotAloneImageOpenRejectsOversizedPixelsBeforeDecodeAllocation(t *testing.T) {
	imageBytes := notaloneTinyPNG(t, 3, 2)
	binary.BigEndian.PutUint32(imageBytes[16:20], 10000)
	binary.BigEndian.PutUint32(imageBytes[20:24], 4001)
	binary.BigEndian.PutUint32(imageBytes[29:33], crc32.ChecksumIEEE(imageBytes[12:29]))
	if _, err := png.DecodeConfig(bytes.NewReader(imageBytes)); err != nil {
		t.Fatalf("synthetic PNG header should be valid before the protocol checks its pixel budget: %v", err)
	}
	fixture := newNotaloneImageProtocolFixtureWithImage(t, `<msg><img /></msg>`, imageBytes)
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	_, err := fixture.history.handle(context.Background(), fixture.request)
	runtime.ReadMemStats(&after)
	allocated := after.TotalAlloc - before.TotalAlloc
	if err == nil || err.Error() != "history_image_quality_unverified" {
		t.Fatalf("image larger than the content decode budget must be rejected: %v", err)
	}
	if allocated >= 8<<20 {
		t.Fatalf("oversized image should be rejected before full decoder allocation: allocated=%d bytes", allocated)
	}
	t.Logf("oversized image rejected before decode: TotalAlloc delta=%d bytes", allocated)
}

func TestNotAloneImageOpenFullyDecodesJPEGAndEveryGIFFrame(t *testing.T) {
	for name, data := range map[string][]byte{
		"jpeg": notaloneTinyJPEG(t, 3, 2),
		"gif":  notaloneTinyGIF(t, 3, 2),
	} {
		t.Run(name, func(t *testing.T) {
			fixture := newNotaloneImageProtocolFixtureWithImage(t, `<msg><img /></msg>`, data)
			value, err := fixture.history.handle(context.Background(), fixture.request)
			if err != nil {
				t.Fatalf("well-formed %s image should fully decode: %v", name, err)
			}
			opened := value.(notaloneImageOpenResponse)
			if opened.Quality != "unknown" || opened.QualityProof.ContentWidth != 3 || opened.QualityProof.ContentHeight != 2 {
				t.Fatalf("decoded %s content should report actual dimensions without original quality: %#v", name, opened)
			}
		})
	}
	truncatedGIF := notaloneTinyGIF(t, 3, 2)
	truncatedGIF = truncatedGIF[:len(truncatedGIF)-1] // 移除所有帧数据后的必需结束标记。
	fixture := newNotaloneImageProtocolFixtureWithImage(t, `<msg><img /></msg>`, truncatedGIF)
	if _, err := fixture.history.handle(context.Background(), fixture.request); err == nil || err.Error() != "history_image_quality_unverified" {
		t.Fatalf("GIF with complete frames but no trailer must fail full validation, got %v", err)
	}
}

func TestNotAloneImageXMLDecoderRejectsInvalidOrUnboundedZstd(t *testing.T) {
	validXML := []byte(`<msg><img /></msg>`)
	valid := notaloneCompressImageXML(t, validXML)
	randomBytes := make([]byte, notaloneImageXMLByteLimit+1)
	if _, err := rand.New(rand.NewSource(20261031)).Read(randomBytes); err != nil {
		t.Fatal(err)
	}
	compressedInputOverLimit := notaloneCompressImageXML(t, randomBytes)
	if len(compressedInputOverLimit) <= notaloneImageXMLByteLimit {
		t.Fatalf("fixture must exceed compressed input bound: got %d bytes", len(compressedInputOverLimit))
	}
	for name, input := range map[string]struct {
		bytes       []byte
		contentType int64
	}{
		"bad frame":                     {bytes: append([]byte{0x28, 0xb5, 0x2f, 0xfd}, 0xff, 0xff), contentType: 4},
		"compressed type without frame": {bytes: validXML, contentType: 4},
		"frame with plain type":         {bytes: valid, contentType: 0},
		"compressed input over limit":   {bytes: compressedInputOverLimit, contentType: 4},
		"expanded output over limit":    {bytes: notaloneCompressImageXML(t, bytes.Repeat([]byte("x"), notaloneImageXMLByteLimit+1)), contentType: 4},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := notaloneDecodeImageXML(input.bytes, input.contentType); err == nil || err.Error() != "history_image_metadata_invalid" {
				t.Fatalf("legacy XML decoder helper must fail closed on invalid zstd framing, got %v", err)
			}
		})
	}
}

func TestNotAloneImageErrorsDistinguishMissingLocalFileKeyAndQuality(t *testing.T) {
	imageBytes := notaloneTinyPNG(t, 3, 2)
	imageXML := notaloneImageXML(imageBytes, len(imageBytes), 3, 2, true)
	metadata, err := notaloneParseOriginalImageXML([]byte(imageXML))
	if err != nil {
		t.Fatal(err)
	}
	wrongBytes := append([]byte(nil), imageBytes...)
	wrongBytes[len(wrongBytes)-1] ^= 1
	if _, _, err = notaloneVerifyOriginalImage(metadata, wrongBytes); err == nil || err.Error() != "history_image_quality_unverified" {
		t.Fatalf("mismatched complete bytes need quality code, got %v", err)
	}

	fixture := newNotaloneImageProtocolFixture(t, imageXML)
	encrypted := append(append([]byte(nil), wechatV4ImageHeader2...), make([]byte, 32)...)
	if _, _, err = notaloneDecodeLocalImage(encrypted, fixture.history.server.cfg); err == nil || err.Error() != "history_image_key_unavailable" {
		t.Fatalf("recognized encrypted container without configured key needs key code, got %v", err)
	}
	if err = os.Remove(fixture.path); err != nil {
		t.Fatal(err)
	}
	if _, err = fixture.history.handle(context.Background(), fixture.request); err == nil || err.Error() != "history_image_local_file_missing" {
		t.Fatalf("absent local original needs missing-file code, got %v", err)
	}
}

func TestNotAloneImageOpenStreamsOnlyVerifiedOriginalFromSelectedSnapshot(t *testing.T) {
	imageBytes := notaloneTinyPNG(t, 3, 2)
	fixture := newNotaloneImageProtocolFixture(t, notaloneImageXML(imageBytes, len(imageBytes), 3, 2, true))
	value, err := fixture.history.handle(context.Background(), fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	opened, ok := value.(notaloneImageOpenResponse)
	if !ok || !opened.Complete || opened.Protocol != "wechat-original-image-v1" || opened.Quality != "original" ||
		opened.QualityProof.Kind != "wechat-message-image-content-v2" || opened.Envelope != "plain" || opened.SourceEnvelope != "plain" ||
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

func TestNotAloneImageOpenStreamsBMPWithOriginalContentProof(t *testing.T) {
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
		t.Fatalf("valid standard top-down BMP was not verified as image content: %#v", value)
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
	rleBytes := notaloneTinyBMPRLE8(t, 2)
	rleFixture := newNotaloneImageProtocolFixtureWithImage(t, `<msg><img /></msg>`, rleBytes)
	if _, err = rleFixture.history.handle(context.Background(), rleFixture.request); err != nil {
		t.Fatalf("well-formed RLE8 BMP pixels should fully decode: %v", err)
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

func TestNotAloneImageOpenConvertsWXGFDespiteMismatchingOriginalImageXML(t *testing.T) {
	png := notaloneTinyPNG(t, 3, 2)
	source := append([]byte("wxgf"), png...)
	wrongXML := `<msg><img md5="00000000000000000000000000000000" hdlength="1" cdnhdwidth="999" cdnhdheight="999" cdnbigimgurl="wrong" /></msg>`
	fixture := newNotaloneImageProtocolFixtureWithImage(t, wrongXML, source)
	helper := filepath.Join(t.TempDir(), "wxgf-helper.sh")
	helperBytes := []byte("#!/bin/sh\n[ \"$1\" = wxgf ] || exit 2\nexec /bin/dd if=/dev/fd/3 bs=1 skip=4 2>/dev/null\n")
	if err := os.WriteFile(helper, helperBytes, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NOTALONE_IMAGE_DECODER", helper)
	t.Setenv("NOTALONE_IMAGE_DECODER_SHA256", fmt.Sprintf("%x", sha256.Sum256(helperBytes)))
	value, err := fixture.history.handle(context.Background(), fixture.request)
	if err != nil {
		t.Fatalf("原图WXGF应经真实解码器保存可查看结果: %v", err)
	}
	opened := value.(notaloneImageOpenResponse)
	raw, _ := json.Marshal(opened.QualityProof)
	var proof map[string]any
	_ = json.Unmarshal(raw, &proof)
	if proof["kind"] != "wechat-message-image-content-v2" || opened.Quality != "unknown" || proof["conversion"] != "wxgf-to-png-v1" || proof["sourceSha256"] != fmt.Sprintf("%x", sha256.Sum256(source)) || proof["verifiedSha256"] == proof["sourceSha256"] || opened.MimeType != "image/png" || opened.QualityProof.ContentWidth != 3 || opened.QualityProof.ContentHeight != 2 {
		t.Fatalf("转换证明须分别保留源与输出: %#v", proof)
	}
}

func TestNotAloneImageOpenCanDecodeBoundThumbnailBytes(t *testing.T) {
	source := notaloneTinyPNG(t, 3, 2)
	fixture := newNotaloneImageProtocolFixtureWithImage(t, notaloneImageXML(source, len(source), 3, 2, true), source)
	if err := os.Rename(fixture.path, strings.TrimSuffix(fixture.path, ".dat")+"_t.dat"); err != nil {
		t.Fatal(err)
	}
	value, err := fixture.history.handle(context.Background(), fixture.request)
	if err != nil {
		t.Fatalf("同消息唯一关联且可解码的缩略图必须带缩略图分类保存: %v", err)
	}
	opened := value.(notaloneImageOpenResponse)
	if opened.Quality != "thumbnail" || opened.QualityProof.Kind != "wechat-message-image-content-v2" {
		t.Fatalf("thumbnail must not be certified as original: %#v", opened)
	}
}

func TestNotAloneImageOpenPrefersStandardThenHighDefinitionThenThumbnail(t *testing.T) {
	primary := notaloneTinyPNG(t, 3, 2)
	other := notaloneTinyPNGWithBaseColor(t, 3, 2, color.RGBA{R: 180, G: 10, B: 40, A: 255})
	if len(primary) != len(other) || bytes.Equal(primary, other) {
		t.Fatalf("candidate conflict fixture must be valid, distinct, and same-sized: primary=%d other=%d", len(primary), len(other))
	}
	wantSHA := func(data []byte) string { return fmt.Sprintf("%x", sha256.Sum256(data)) }
	openedImage := func(t *testing.T, fixture notaloneImageProtocolFixture) notaloneImageOpenResponse {
		t.Helper()
		value, err := fixture.history.handle(context.Background(), fixture.request)
		if err != nil {
			t.Fatalf("可查看的标准图或高清图存在时必须保存其中一张: %v", err)
		}
		return value.(notaloneImageOpenResponse)
	}
	t.Run("non-thumbnail beats conflicting thumbnail without reading it", func(t *testing.T) {
		fixture := newNotaloneImageProtocolFixtureWithImage(t, `<msg><img /></msg>`, primary)
		thumbnail := strings.TrimSuffix(fixture.path, ".dat") + "_t.dat"
		if err := os.WriteFile(thumbnail, other, 0600); err != nil {
			t.Fatal(err)
		}
		opened := openedImage(t, fixture)
		if opened.ExpectedSHA256 != wantSHA(primary) {
			t.Fatalf("selected bytes must come from the non-thumbnail candidate: %#v", opened)
		}
	})
	t.Run("标准图与高清图并存且内容不同时取标准图", func(t *testing.T) {
		fixture := newNotaloneImageProtocolFixtureWithImage(t, `<msg><img /></msg>`, primary)
		hdCandidate := strings.TrimSuffix(fixture.path, ".dat") + "_h.dat"
		if err := os.WriteFile(hdCandidate, other, 0600); err != nil {
			t.Fatal(err)
		}
		opened := openedImage(t, fixture)
		if opened.ExpectedSHA256 != wantSHA(primary) || opened.QualityProof.SourceVariant != "main" {
			t.Fatalf("两张都核验通过时必须固定取标准图，不比较内容: %#v", opened)
		}
	})
	t.Run("标准图失败时回退高清图", func(t *testing.T) {
		for _, tc := range []struct {
			name     string
			standard []byte
		}{
			{"标准图大小与消息资源不符", primary[:len(primary)-1]},
			{"标准图大小相符但无法解码", bytes.Repeat([]byte{0x5a}, len(primary))},
		} {
			t.Run(tc.name, func(t *testing.T) {
				fixture := newNotaloneImageProtocolFixtureWithImage(t, `<msg><img /></msg>`, primary)
				hdCandidate := strings.TrimSuffix(fixture.path, ".dat") + "_h.dat"
				if err := os.WriteFile(hdCandidate, other, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(fixture.path, tc.standard, 0600); err != nil {
					t.Fatal(err)
				}
				opened := openedImage(t, fixture)
				if opened.ExpectedSHA256 != wantSHA(other) || opened.QualityProof.SourceVariant != "main" || opened.Quality == "thumbnail" {
					t.Fatalf("标准图不可用时必须取高清图: %#v", opened)
				}
			})
		}
	})
	t.Run("只有高清图时取高清图", func(t *testing.T) {
		fixture := newNotaloneImageProtocolFixtureWithImage(t, `<msg><img /></msg>`, primary)
		if err := os.Rename(fixture.path, strings.TrimSuffix(fixture.path, ".dat")+"_h.dat"); err != nil {
			t.Fatal(err)
		}
		opened := openedImage(t, fixture)
		if opened.ExpectedSHA256 != wantSHA(primary) || opened.Quality == "thumbnail" {
			t.Fatalf("只有高清图也必须保存: %#v", opened)
		}
	})
	t.Run("标准图与高清图都不可用时仍按缩略图返回", func(t *testing.T) {
		fixture := newNotaloneImageProtocolFixtureWithImage(t, `<msg><img /></msg>`, primary)
		base := strings.TrimSuffix(fixture.path, ".dat")
		if err := os.WriteFile(fixture.path, primary[:len(primary)-1], 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(base+"_h.dat", bytes.Repeat([]byte{0x5a}, len(primary)), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(base+"_t.dat", other, 0600); err != nil {
			t.Fatal(err)
		}
		opened := openedImage(t, fixture)
		if opened.Quality != "thumbnail" || opened.QualityProof.SourceVariant != "thumbnail" || opened.ExpectedSHA256 != wantSHA(other) {
			t.Fatalf("只有缩略图可用时必须带缩略图分类返回，由后台决定是否保存: %#v", opened)
		}
	})
}

func TestNotAloneImageClassificationUsesBoundResourceRole(t *testing.T) {
	for _, tc := range []struct {
		name             string
		width, height    int
		thumbnail        bool
		originalMetadata bool
		typeRaw          int64
		wantQuality      string
	}{
		{"小图有原图内容依据", 3, 2, false, true, 65537, "original"},
		{"大图仍是已绑定缩略图", 1280, 960, true, true, 65537, "thumbnail"},
		{"未知资源高位不冒充原图", 3, 2, false, false, 99<<16 | 1, "unknown"},
		{"未知资源高位不推翻原图内容证明", 3, 2, false, true, 99<<16 | 1, "original"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := notaloneTinyPNG(t, tc.width, tc.height)
			message := []byte(`<msg><img /></msg>`)
			if tc.originalMetadata {
				message = []byte(notaloneImageXML(data, len(data), tc.width, tc.height, true))
			}
			const cacheMD5 = "f71dbe52628a3f83a77ab494817525c6"
			packed := notaloneTestPackedInfo(cacheMD5)
			fixture := newNotaloneImageProtocolFixtureWithResourceData(t, message, 0, data, data, cacheMD5, packed, packed,
				[]notaloneImageTestResourceDetail{{id: 11, typeRaw: tc.typeRaw, size: int64(len(data)), packedInfo: packed}})
			wantVariant := "main"
			if tc.thumbnail {
				wantVariant = "thumbnail"
				if err := os.Rename(fixture.path, strings.TrimSuffix(fixture.path, ".dat")+"_t.dat"); err != nil {
					t.Fatal(err)
				}
			}
			value, err := fixture.history.handle(context.Background(), fixture.request)
			if err != nil {
				t.Fatal(err)
			}
			opened := value.(notaloneImageOpenResponse)
			wire, _ := json.Marshal(opened.QualityProof)
			var proof map[string]any
			if err = json.Unmarshal(wire, &proof); err != nil {
				t.Fatal(err)
			}
			resources, _ := proof["matchingResources"].([]any)
			if opened.Quality != tc.wantQuality || proof["kind"] != "wechat-message-image-content-v2" || proof["sourceVariant"] != wantVariant || len(resources) != 1 {
				t.Fatalf("分类必须来自已认证消息资源及所选版本，不能按尺寸或高位猜测: quality=%s proof=%#v", opened.Quality, proof)
			}
			resource := resources[0].(map[string]any)
			if resource["resourceId"] != "11" || resource["resourceTypeRaw"] != float64(tc.typeRaw) {
				t.Fatalf("资源分类审计信息缺失: %#v", resource)
			}
			original, ok := proof["originalProof"].(map[string]any)
			if tc.wantQuality == "original" {
				if !ok || original["kind"] != "wechat-cdn-big-hd-exact-content-v4" || original["sourceSha256"] != proof["sourceSha256"] || original["resourceInfoId"] != proof["resourceInfoId"] {
					t.Fatalf("原图需同一资源的完整内容证明: %#v", proof)
				}
			} else if ok || proof["originalProof"] != nil {
				t.Fatalf("非原图不能附原图证明: %#v", proof)
			}
		})
	}
}

func TestNotAloneImageClassificationTreatsOptionalMetadataAsNonBlocking(t *testing.T) {
	data := notaloneTinyPNG(t, 3, 2)
	valid := []byte(notaloneImageXML(data, len(data), 3, 2, true))
	for _, tc := range []struct {
		name        string
		content     []byte
		contentType int64
		quality     string
	}{
		{"压缩元数据可核验原图", notaloneCompressImageXML(t, valid), 4, "original"},
		{"压缩元数据损坏仍可保存", []byte{0x28, 0xb5, 0x2f, 0xfd, 0}, 4, "unknown"},
		{"元数据超限仍可保存", bytes.Repeat([]byte("x"), notaloneImageXMLByteLimit+1), 0, "unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fixture := newNotaloneImageProtocolFixtureWithMessageContent(t, tc.content, tc.contentType, data)
			value, err := fixture.history.handle(context.Background(), fixture.request)
			if err != nil {
				t.Fatalf("原图分类依据不可用不能阻断普通图片保存: %v", err)
			}
			opened := value.(notaloneImageOpenResponse)
			if opened.Quality != tc.quality || opened.QualityProof.SourceVariant != "main" || opened.ExpectedSHA256 != fmt.Sprintf("%x", sha256.Sum256(data)) {
				t.Fatalf("可选元数据分类结果错误: %#v", opened)
			}
		})
	}
}
