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
	"encoding/json"
	"encoding/xml"
	"hash"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	mathbits "math/bits"
	"os"
	"os/exec"
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
	notaloneImageQualityProofKind    = "wechat-message-image-content-v2"
	notaloneOriginalImageProofKind   = "wechat-cdn-big-hd-exact-content-v4"
	notaloneImageXMLZstdContentType  = int64(4)
	notaloneImageMaxGIFFrames        = 120
	notaloneImageMaxGIFPixels        = int64(80_000_000)
	notaloneImageContentPixelLimit   = int64(40_000_000)
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

type notaloneImageMatchedResource struct {
	ResourceID      string `json:"resourceId"`
	ResourceTypeRaw int64  `json:"resourceTypeRaw"`
}

type notaloneImageQualityProof struct {
	Kind                string                             `json:"kind"`
	ResourceInfoID      string                             `json:"resourceInfoId"`
	MatchingResourceIDs []string                           `json:"matchingResourceIds"`
	ResourceSize        int64                              `json:"resourceSize"`
	VerifiedBytes       int64                              `json:"verifiedBytes"`
	VerifiedSHA256      string                             `json:"verifiedSha256"`
	SourceSHA256        string                             `json:"sourceSha256"`
	Conversion          string                             `json:"conversion"`
	ContentWidth        int                                `json:"contentWidth"`
	ContentHeight       int                                `json:"contentHeight"`
	SourceVariant       string                             `json:"sourceVariant"`
	MatchingResources   []notaloneImageMatchedResource     `json:"matchingResources"`
	OriginalProof       *notaloneOriginalImageQualityProof `json:"originalProof"`
}

// 原图内容证明作为可选分类依据，不影响普通图和缩略图保存。
type notaloneOriginalImageQualityProof struct {
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
	SourceSHA256        string   `json:"sourceSha256"`
	Conversion          string   `json:"conversion"`
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
	if !md5LikeRe.MatchString(md5Value) || img.HDLength < 0 || img.HDLength > notaloneImageMaxBytes || (img.CdnHDWidth == nil) != (img.CdnHDHeight == nil) {
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
		HDWidth: hdWidth, HDHeight: hdHeight, BigURLFound: strings.TrimSpace(img.CdnBigURL) != ""}
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
	return notaloneImageDimensionsWithPixelLimit(data, int64(notaloneImageMaxPixelCount))
}

func notaloneContentImageDimensions(data []byte) (int, int, error) {
	return notaloneImageDimensionsWithPixelLimit(data, notaloneImageContentPixelLimit)
}

func notaloneImageDimensionsWithPixelLimit(data []byte, pixelLimit int64) (int, int, error) {
	fail := func() (int, int, error) { return 0, 0, notaloneFailure("history_image_quality_unverified") }
	if len(data) == 0 || int64(len(data)) > notaloneImageMaxBytes {
		return fail()
	}
	switch imageExtForData(data) {
	case "jpg", "jpeg":
		config, err := jpeg.DecodeConfig(bytes.NewReader(data))
		if err != nil || !notaloneImageDimensionsWithinPixelLimit(config.Width, config.Height, pixelLimit) {
			return fail()
		}
		decoded, err := jpeg.Decode(bytes.NewReader(data))
		if err != nil || decoded.Bounds().Dx() != config.Width || decoded.Bounds().Dy() != config.Height {
			return fail()
		}
		return config.Width, config.Height, nil
	case "png":
		config, err := png.DecodeConfig(bytes.NewReader(data))
		if err != nil || !notaloneImageDimensionsWithinPixelLimit(config.Width, config.Height, pixelLimit) {
			return fail()
		}
		decoded, err := png.Decode(bytes.NewReader(data))
		if err != nil || decoded.Bounds().Dx() != config.Width || decoded.Bounds().Dy() != config.Height {
			return fail()
		}
		return config.Width, config.Height, nil
	case "gif":
		width, height, frames, err := notaloneGIFFramePixelCountWithPixelLimit(data, pixelLimit)
		if err != nil || frames < 1 || frames > notaloneImageMaxGIFFrames {
			return fail()
		}
		decoded, err := gif.DecodeAll(bytes.NewReader(data))
		if err != nil || len(decoded.Image) != frames || len(decoded.Image) == 0 ||
			decoded.Config.Width != width || decoded.Config.Height != height {
			return fail()
		}
		return width, height, nil
	case "bmp":
		return notaloneDecodeBMPWithPixelLimit(data, pixelLimit)
	default:
		return fail()
	}
}

func notaloneImageDimensionsWithinLimits(width, height int) bool {
	return notaloneImageDimensionsWithinPixelLimit(width, height, int64(notaloneImageMaxPixelCount))
}

func notaloneImageDimensionsWithinPixelLimit(width, height int, pixelLimit int64) bool {
	return width > 0 && height > 0 && width <= notaloneImageMaxDimension && height <= notaloneImageMaxDimension &&
		pixelLimit > 0 && int64(width)*int64(height) <= pixelLimit
}

func notaloneGIFFramePixelCount(data []byte) (int, int, int, error) {
	return notaloneGIFFramePixelCountWithPixelLimit(data, int64(notaloneImageMaxPixelCount))
}

func notaloneGIFFramePixelCountWithPixelLimit(data []byte, pixelLimit int64) (int, int, int, error) {
	fail := func() (int, int, int, error) { return 0, 0, 0, notaloneFailure("history_image_quality_unverified") }
	if len(data) < 13 || string(data[:6]) != "GIF87a" && string(data[:6]) != "GIF89a" {
		return fail()
	}
	width := int(binary.LittleEndian.Uint16(data[6:8]))
	height := int(binary.LittleEndian.Uint16(data[8:10]))
	if !notaloneImageDimensionsWithinPixelLimit(width, height, pixelLimit) {
		return fail()
	}
	position := 13
	if data[10]&0x80 != 0 {
		position += 3 * (1 << ((data[10] & 0x07) + 1))
	}
	if position > len(data) {
		return fail()
	}
	frames := 0
	var totalPixels int64
	framePixelLimit := notaloneImageMaxGIFPixels
	if pixelLimit < framePixelLimit {
		framePixelLimit = pixelLimit
	}
	skipBlocks := func() bool {
		for {
			if position >= len(data) {
				return false
			}
			size := int(data[position])
			position++
			if size == 0 {
				return true
			}
			if position+size > len(data) {
				return false
			}
			position += size
		}
	}
	for position < len(data) {
		marker := data[position]
		position++
		switch marker {
		case 0x3b:
			if frames == 0 {
				return fail()
			}
			return width, height, frames, nil
		case 0x21:
			if position >= len(data) {
				return fail()
			}
			position++ // 跳过扩展标签。
			if !skipBlocks() {
				return fail()
			}
		case 0x2c:
			if position+9 > len(data) {
				return fail()
			}
			x := int(binary.LittleEndian.Uint16(data[position : position+2]))
			y := int(binary.LittleEndian.Uint16(data[position+2 : position+4]))
			frameWidth := int(binary.LittleEndian.Uint16(data[position+4 : position+6]))
			frameHeight := int(binary.LittleEndian.Uint16(data[position+6 : position+8]))
			packed := data[position+8]
			position += 9
			if frameWidth <= 0 || frameHeight <= 0 || x+frameWidth > width || y+frameHeight > height ||
				int64(frameWidth)*int64(frameHeight) > framePixelLimit {
				return fail()
			}
			if packed&0x80 != 0 {
				position += 3 * (1 << ((packed & 0x07) + 1))
			}
			if position >= len(data) {
				return fail()
			}
			position++ // 跳过 LZW 最小码长，具体值由 GIF 解码器验证。
			if position > len(data) || !skipBlocks() {
				return fail()
			}
			frames++
			totalPixels += int64(frameWidth) * int64(frameHeight)
			if frames > notaloneImageMaxGIFFrames || totalPixels > framePixelLimit {
				return fail()
			}
		default:
			return fail()
		}
	}
	return fail()
}

func notaloneDecodeBMP(data []byte) (int, int, error) {
	return notaloneDecodeBMPWithPixelLimit(data, int64(notaloneImageMaxPixelCount))
}

func notaloneDecodeBMPWithPixelLimit(data []byte, pixelLimit int64) (int, int, error) {
	width, height, err := notaloneBMPDimensions(data)
	if err != nil {
		return 0, 0, err
	}
	if !notaloneImageDimensionsWithinPixelLimit(width, height, pixelLimit) {
		return 0, 0, notaloneFailure("history_image_quality_unverified")
	}
	core := binary.LittleEndian.Uint32(data[14:18]) == 12
	bitsOffset := 28
	if core {
		bitsOffset = 24
	}
	bits := int(binary.LittleEndian.Uint16(data[bitsOffset : bitsOffset+2]))
	compression := uint32(0)
	imageSize := uint32(0)
	colorsUsed := uint32(0)
	if !core {
		compression = binary.LittleEndian.Uint32(data[30:34])
		imageSize = binary.LittleEndian.Uint32(data[34:38])
		colorsUsed = binary.LittleEndian.Uint32(data[46:50])
	}
	pixelOffset := int(binary.LittleEndian.Uint32(data[10:14]))
	paletteStart := 14 + int(binary.LittleEndian.Uint32(data[14:18]))
	if core {
		paletteStart = 26
	}
	if !core && (compression == 3 || compression == 6) && binary.LittleEndian.Uint32(data[14:18]) == 40 {
		maskCount := 3
		if compression == 6 {
			maskCount = 4
		}
		paletteStart += 4 * maskCount
	}
	var paletteSize int
	if bits <= 8 {
		paletteSize = 1 << bits
		if colorsUsed != 0 {
			paletteSize = int(colorsUsed)
		}
	}
	entryBytes := 4
	if core {
		entryBytes = 3
	}
	paletteEnd := paletteStart + paletteSize*entryBytes
	if paletteEnd > pixelOffset || paletteEnd > len(data) {
		return 0, 0, notaloneFailure("history_image_quality_unverified")
	}
	palette := make([][4]byte, paletteSize)
	for index := range palette {
		entry := data[paletteStart+index*entryBytes : paletteStart+(index+1)*entryBytes]
		palette[index] = [4]byte{entry[2], entry[1], entry[0], 255}
	}
	validIndex := func(index int) bool { return bits > 8 || index >= 0 && index < paletteSize }
	if compression == 1 || compression == 2 {
		if err := notaloneDecodeBMPRLE(data[pixelOffset:pixelOffset+int(imageSize)], width, height, bits, paletteSize, compression == 1); err != nil {
			return 0, 0, err
		}
		return width, height, nil
	}
	if compression != 0 && compression != 3 && compression != 6 {
		return 0, 0, notaloneFailure("history_image_quality_unverified")
	}
	var redMask, greenMask, blueMask, alphaMask uint32
	switch {
	case compression == 3 || compression == 6:
		dibSize := int(binary.LittleEndian.Uint32(data[14:18]))
		maskOffset := 54
		if dibSize < 52 {
			maskOffset = 14 + dibSize
		}
		redMask = binary.LittleEndian.Uint32(data[maskOffset : maskOffset+4])
		greenMask = binary.LittleEndian.Uint32(data[maskOffset+4 : maskOffset+8])
		blueMask = binary.LittleEndian.Uint32(data[maskOffset+8 : maskOffset+12])
		if compression == 6 {
			if dibSize >= 56 {
				alphaMask = binary.LittleEndian.Uint32(data[14+52 : 14+56])
			} else {
				alphaMask = binary.LittleEndian.Uint32(data[maskOffset+12 : maskOffset+16])
			}
		}
	case bits == 16:
		redMask, greenMask, blueMask = 0x7c00, 0x03e0, 0x001f
	case bits == 32:
		redMask, greenMask, blueMask = 0x00ff0000, 0x0000ff00, 0x000000ff
	}
	if bits == 16 || bits == 32 {
		if !notaloneBMPMaskValid(redMask, bits) || !notaloneBMPMaskValid(greenMask, bits) || !notaloneBMPMaskValid(blueMask, bits) ||
			redMask&greenMask != 0 || redMask&blueMask != 0 || greenMask&blueMask != 0 || alphaMask&(redMask|greenMask|blueMask) != 0 ||
			alphaMask != 0 && !notaloneBMPMaskValid(alphaMask, bits) {
			return 0, 0, notaloneFailure("history_image_quality_unverified")
		}
	}
	decodedPixels := sha256.New()
	rowBytes := ((width*bits + 31) / 32) * 4
	for row := 0; row < height; row++ {
		fileRow := row
		if !core && int32(binary.LittleEndian.Uint32(data[22:26])) > 0 {
			fileRow = height - 1 - row
		}
		line := data[pixelOffset+fileRow*rowBytes : pixelOffset+(fileRow+1)*rowBytes]
		for column := 0; column < width; column++ {
			var pixel [4]byte
			switch bits {
			case 1:
				index := int((line[column/8] >> (7 - uint(column%8))) & 1)
				if !validIndex(index) {
					return 0, 0, notaloneFailure("history_image_quality_unverified")
				}
				pixel = palette[index]
			case 4:
				value := line[column/2]
				index := value & 0x0f
				if column%2 == 0 {
					index = value >> 4
				}
				if !validIndex(int(index)) {
					return 0, 0, notaloneFailure("history_image_quality_unverified")
				}
				pixel = palette[index]
			case 8:
				index := int(line[column])
				if !validIndex(index) {
					return 0, 0, notaloneFailure("history_image_quality_unverified")
				}
				pixel = palette[index]
			case 16:
				value := uint32(binary.LittleEndian.Uint16(line[column*2 : column*2+2]))
				pixel[0], _ = notaloneBMPMaskChannel(value, redMask, bits)
				pixel[1], _ = notaloneBMPMaskChannel(value, greenMask, bits)
				pixel[2], _ = notaloneBMPMaskChannel(value, blueMask, bits)
				pixel[3] = 255
				if alphaMask != 0 {
					pixel[3], _ = notaloneBMPMaskChannel(value, alphaMask, bits)
				}
			case 24:
				pixel = [4]byte{line[column*3+2], line[column*3+1], line[column*3], 255}
			case 32:
				value := binary.LittleEndian.Uint32(line[column*4 : column*4+4])
				pixel[0], _ = notaloneBMPMaskChannel(value, redMask, bits)
				pixel[1], _ = notaloneBMPMaskChannel(value, greenMask, bits)
				pixel[2], _ = notaloneBMPMaskChannel(value, blueMask, bits)
				pixel[3] = 255
				if alphaMask != 0 {
					pixel[3], _ = notaloneBMPMaskChannel(value, alphaMask, bits)
				}
			default:
				return 0, 0, notaloneFailure("history_image_quality_unverified")
			}
			_, _ = decodedPixels.Write(pixel[:])
		}
	}
	if len(decodedPixels.Sum(nil)) != sha256.Size {
		return 0, 0, notaloneFailure("history_image_quality_unverified")
	}
	return width, height, nil
}

func notaloneBMPMaskValid(mask uint32, depth int) bool {
	if mask == 0 || depth != 16 && depth != 32 || depth == 16 && mask>>16 != 0 {
		return false
	}
	shift := mathbits.TrailingZeros32(mask)
	normalized := mask >> shift
	return normalized&(normalized+1) == 0
}

func notaloneBMPMaskChannel(value, mask uint32, depth int) (byte, bool) {
	if !notaloneBMPMaskValid(mask, depth) {
		return 0, false
	}
	shift := mathbits.TrailingZeros32(mask)
	maximum := mask >> shift
	component := (value & mask) >> shift
	return byte((uint64(component)*255 + uint64(maximum)/2) / uint64(maximum)), true
}

func notaloneDecodeBMPRLE(data []byte, width, height, bits, paletteSize int, rle8 bool) error {
	fail := func() error { return notaloneFailure("history_image_quality_unverified") }
	if rle8 && bits != 8 || !rle8 && bits != 4 || len(data) < 2 {
		return fail()
	}
	x, y, position := 0, height-1, 0
	validIndex := func(index int) bool { return index >= 0 && index < paletteSize }
	for position+2 <= len(data) {
		count, value := int(data[position]), int(data[position+1])
		position += 2
		if count != 0 {
			if y < 0 || x+count > width {
				return fail()
			}
			for index := 0; index < count; index++ {
				pixel := value
				if !rle8 && index%2 == 1 {
					pixel &= 0x0f
				} else if !rle8 {
					pixel >>= 4
				}
				if !validIndex(pixel) {
					return fail()
				}
			}
			x += count
			continue
		}
		switch value {
		case 0: // 行结束。
			x, y = 0, y-1
		case 1: // 位图结束。
			return nil
		case 2: // 增量移动。
			if position+2 > len(data) {
				return fail()
			}
			x += int(data[position])
			y -= int(data[position+1])
			position += 2
			if x > width || y < 0 || y >= height {
				return fail()
			}
		default: // 绝对像素段。
			pixels := value
			byteCount := pixels
			if !rle8 {
				byteCount = (pixels + 1) / 2
			}
			paddedBytes := byteCount + byteCount%2
			if y < 0 || x+pixels > width || position+paddedBytes > len(data) {
				return fail()
			}
			for index := 0; index < pixels; index++ {
				pixel := int(data[position+index])
				if !rle8 {
					pixel = int(data[position+index/2])
					if index%2 == 0 {
						pixel >>= 4
					} else {
						pixel &= 0x0f
					}
				}
				if !validIndex(pixel) {
					return fail()
				}
			}
			x += pixels
			position += paddedBytes
		}
	}
	return fail()
}

func notaloneVerifyOriginalImage(metadata notaloneOriginalImageMetadata, data []byte) (notaloneOriginalImageQualityProof, string, error) {
	return notaloneVerifyOriginalImageContent(metadata, data, data, "none")
}

func notaloneVerifyOriginalImageContent(metadata notaloneOriginalImageMetadata, source, data []byte, conversion string) (notaloneOriginalImageQualityProof, string, error) {
	proof := notaloneOriginalImageQualityProof{}
	fail := func() (notaloneOriginalImageQualityProof, string, error) {
		return proof, "", notaloneFailure("history_image_quality_unverified")
	}
	if !metadata.BigURLFound || !md5LikeRe.MatchString(metadata.MD5) || metadata.HDLength <= 0 || int64(len(source)) != metadata.HDLength ||
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
	md5Sum := md5.Sum(source)
	if !strings.EqualFold(hex.EncodeToString(md5Sum[:]), metadata.MD5) {
		return fail()
	}
	sha := sha256.Sum256(data)
	sourceSHA := sha256.Sum256(source)
	proof = notaloneOriginalImageQualityProof{Kind: notaloneOriginalImageProofKind, MessageMD5: metadata.MD5, HDLength: metadata.HDLength,
		HDWidth: metadata.HDWidth, HDHeight: metadata.HDHeight, BigImageURLFound: true, ResourceSize: metadata.HDLength,
		VerifiedBytes: int64(len(data)), VerifiedSHA256: hex.EncodeToString(sha[:]), ContentWidth: width, ContentHeight: height,
		SourceSHA256: hex.EncodeToString(sourceSHA[:]), Conversion: conversion}
	return proof, mimeType, nil
}

func notaloneVerifyImageContent(source, data []byte, conversion string) (notaloneImageQualityProof, string, error) {
	fail := func() (notaloneImageQualityProof, string, error) {
		return notaloneImageQualityProof{}, "", notaloneFailure("history_image_quality_unverified")
	}
	if len(source) == 0 || int64(len(source)) > notaloneImageSourceByteLimit || len(data) == 0 || int64(len(data)) > notaloneImageMaxBytes {
		return fail()
	}
	switch conversion {
	case "none":
		if !bytes.Equal(source, data) {
			return fail()
		}
	case "wxgf-to-png-v1":
		if !bytes.HasPrefix(source, []byte("wxgf")) || imageMIMEForExt(imageExtForData(data)) != "image/png" {
			return fail()
		}
	default:
		return fail()
	}
	ext := imageExtForData(data)
	mimeType := imageMIMEForExt(ext)
	switch mimeType {
	case "image/jpeg", "image/png", "image/gif", "image/bmp":
	default:
		return fail()
	}
	width, height, err := notaloneContentImageDimensions(data)
	if err != nil || !notaloneImageDimensionsWithinPixelLimit(width, height, notaloneImageContentPixelLimit) {
		return fail()
	}
	verifiedSHA := sha256.Sum256(data)
	sourceSHA := sha256.Sum256(source)
	proof := notaloneImageQualityProof{Kind: notaloneImageQualityProofKind, ResourceSize: int64(len(source)),
		VerifiedBytes: int64(len(data)), VerifiedSHA256: hex.EncodeToString(verifiedSHA[:]),
		SourceSHA256: hex.EncodeToString(sourceSHA[:]), Conversion: conversion, ContentWidth: width, ContentHeight: height}
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
	resource, resourceGuard, err := h.findMessageImageResource(ctx, message)
	if err != nil {
		return failed, err
	}
	resourceKeep := false
	defer func() {
		if !resourceKeep {
			_ = resourceGuard.Close()
		}
	}()
	if request.ImageKeySupplied && h.imageRuntimeConfig == nil {
		if err = h.acceptImageRuntimeKey(); err != nil {
			return failed, err
		}
	}
	imageData, sourceEnvelope, imageGuard, proof, mimeType, err := h.readMessageImage(ctx, message, &resource)
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
		"info_packed_sha256", resource.InfoPackedInfoSHA256, "verified_sha256", proof.VerifiedSHA256,
		"classification", proof.Kind, proof.SourceVariant}
	for _, detail := range resource.MatchingDetails {
		resourceIdentityParts = append(resourceIdentityParts, "resource_detail", strconv.FormatInt(detail.ID, 10), strconv.FormatInt(detail.TypeRaw, 10),
			strconv.FormatInt(detail.Size, 10), strconv.FormatInt(detail.Status, 10), detail.DataIndex, strconv.FormatInt(detail.CreateTime, 10),
			strconv.FormatInt(detail.AccessTime, 10), strconv.FormatInt(detail.PackedInfoLength, 10), detail.PackedInfoSHA256)
	}
	quality := "unknown"
	if proof.SourceVariant == "thumbnail" {
		quality = "thumbnail"
	} else if proof.OriginalProof != nil {
		quality = "original"
		resourceIdentityParts = append(resourceIdentityParts, "original_proof", proof.OriginalProof.Kind, proof.OriginalProof.MessageMD5, proof.OriginalProof.SourceSHA256)
	}
	resourceSourceGeneration := notaloneHash(resourceIdentityParts...)
	response := notaloneImageOpenResponse{
		Protocol: "wechat-original-image-v1", ResourceToken: resourceToken,
		SourceGeneration: target.SourceGeneration, ResourceSourceGeneration: resourceSourceGeneration,
		Target: target.Descriptor, Partition: request.Partition, Table: request.Table, LocalID: request.LocalID,
		ServerID: request.ServerID, SentAt: request.SentAt, ResourceTable: notaloneImageResourceTableID,
		ResourceID: strconv.FormatInt(resource.ID, 10), ResourceTypeRaw: resource.TypeRaw, VariantCode: resource.TypeRaw >> 16,
		Complete: true, Quality: quality, QualityProof: proof, Envelope: "plain", SourceEnvelope: sourceEnvelope,
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
	partition        string
	tableInstance    string
	localID          int64
	serverID         int64
	localType        int64
	createTime       int64
	cacheMD5         string
	resourceDBPath   string
	originalMetadata *notaloneOriginalImageMetadata
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
	query := "SELECT local_id,server_id,local_type,create_time,CASE WHEN (local_type & 4294967295)=3 THEN CASE WHEN length(CAST(packed_info_data AS BLOB))<=? THEN packed_info_data ELSE NULL END ELSE NULL END AS image_message_packed_info,CASE WHEN (local_type & 4294967295)=3 THEN length(CAST(packed_info_data AS BLOB)) ELSE 0 END AS image_message_packed_info_length,CASE WHEN (local_type & 4294967295)=3 AND length(CAST(message_content AS BLOB))<=? THEN message_content ELSE NULL END AS image_message_content"
	if shard.hasContentTypeColumn {
		query += ",WCDB_CT_message_content AS image_message_content_type"
	}
	query += " FROM " + quoteIdent(snapshot.table) + " WHERE local_id=? LIMIT 2"
	rows, err := shard.reader.QueryBounded(ctx, 2, query, int64(notaloneImagePackedInfoByteLimit), int64(notaloneImageXMLByteLimit), localID)
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
	cacheMD5, validCacheMD5 := notaloneSinglePackedMD5(rowBytes(row, "image_message_packed_info"), rowInt64(row, "image_message_packed_info_length"))
	if !validCacheMD5 {
		return message, target, notaloneFailure("history_image_association_unverified")
	}
	resourcePath, err := h.server.validatedDBPath("message", "message_resource.db")
	if err != nil {
		return message, target, notaloneFailure("history_image_association_unverified")
	}
	// 分类只使用同一稳定消息的有界元数据；缺失、损坏或不匹配不得阻断可查看图片。
	var originalMetadata *notaloneOriginalImageMetadata
	if xmlBytes, decodeErr := notaloneDecodeImageXML(rowBytes(row, "image_message_content"), rowInt64(row, "image_message_content_type")); decodeErr == nil {
		if parsed, parseErr := notaloneParseOriginalImageXML(xmlBytes); parseErr == nil {
			originalMetadata = &parsed
		}
	}
	message = notaloneSnapshotImageMessage{originalMetadata: originalMetadata, partition: shard.partition, tableInstance: shard.instance, localID: rowLocalID,
		serverID: rowServerID, localType: rowType, createTime: rowCreateTime, cacheMD5: cacheMD5, resourceDBPath: resourcePath}
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

func (h *notaloneHistorySession) findMessageImageResource(ctx context.Context, message notaloneSnapshotImageMessage) (notaloneImageResourceRecord, *notaloneSourceGuard, error) {
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
		if id <= 0 || id <= previousID || rawType&0xffff != 1 || size < 0 || size > notaloneImageSourceByteLimit {
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

func (h *notaloneHistorySession) readMessageImage(ctx context.Context, message notaloneSnapshotImageMessage, resource *notaloneImageResourceRecord) ([]byte, string, *notaloneSourceGuard, notaloneImageQualityProof, string, error) {
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
	var selected *verifiedCandidate
	var foundCandidate, foundAssociation, associationUnverified, qualityUnverified, keyUnavailable bool
	var decoderFailure string
	for _, suffixes := range [][]string{{".dat", "_h.dat"}, {"_t.dat"}} {
		for _, suffix := range suffixes {
			if err := ctx.Err(); err != nil {
				return nil, "", nil, emptyProof, "", notaloneFailure("history_image_read_failed")
			}
			candidate := filepath.Join(baseDir, resource.CacheMD5+suffix)
			guard, resolved, err := h.guardImageCandidate(candidate)
			if err != nil {
				if err.Error() == "history_image_source_changed" {
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
			imageConfig := h.server.cfg
			if h.imageRuntimeConfig != nil {
				imageConfig = h.imageRuntimeConfig
			}
			decoded, envelope, err := notaloneDecodeLocalImage(data, imageConfig)
			if err != nil {
				_ = guard.Close()
				if err.Error() == "history_image_key_unavailable" {
					keyUnavailable = true
				} else {
					qualityUnverified = true
				}
				continue
			}
			viewable, conversion, decodeErr := notaloneDecodeImageContent(ctx, decoded)
			if decodeErr != nil {
				_ = guard.Close()
				decoderFailure = decodeErr.Error()
				continue
			}
			proof, mimeType, err := notaloneVerifyImageContent(decoded, viewable, conversion)
			if err != nil {
				_ = guard.Close()
				qualityUnverified = true
				continue
			}
			if guard.Check() != nil {
				_ = guard.Close()
				return nil, "", nil, emptyProof, "", notaloneFailure("history_image_source_changed")
			}
			proof.SourceVariant = "main"
			if suffix == "_t.dat" {
				proof.SourceVariant = "thumbnail"
			}
			// 资源高位仅留作审计；原图必须由此消息声明与实际解密内容共同证实。
			if proof.SourceVariant == "main" && message.originalMetadata != nil {
				if original, _, originalErr := notaloneVerifyOriginalImageContent(*message.originalMetadata, decoded, viewable, conversion); originalErr == nil {
					proof.OriginalProof = &original
				}
			}
			proof.ResourceInfoID = strconv.FormatInt(resource.InfoID, 10)
			proof.MatchingResourceIDs = make([]string, 0, len(matching))
			for _, detail := range matching {
				proof.MatchingResourceIDs = append(proof.MatchingResourceIDs, strconv.FormatInt(detail.ID, 10))
				proof.MatchingResources = append(proof.MatchingResources, notaloneImageMatchedResource{ResourceID: strconv.FormatInt(detail.ID, 10), ResourceTypeRaw: detail.TypeRaw})
			}
			proof.ResourceSize = int64(len(data))
			if proof.OriginalProof != nil {
				proof.OriginalProof.ResourceInfoID = proof.ResourceInfoID
				proof.OriginalProof.MatchingResourceIDs = append([]string(nil), proof.MatchingResourceIDs...)
				proof.OriginalProof.ResourceSize = proof.ResourceSize
			}
			// 标准图与高清图各自独立核验并可能解码出不同内容；按 .dat、_h.dat 的顺序取第一张核验通过的，
			// 不比较内容、不因并存失败，也不再读取后面的候选。
			selected = &verifiedCandidate{data: viewable, envelope: envelope, guard: guard, proof: proof,
				mimeType: mimeType, record: matching[0], matching: matching}
			break
		}
		// 已有标准图或高清图时不读取缩略图；二者都不可用才进入缩略图档。
		if selected != nil {
			break
		}
	}
	if selected != nil {
		resource.ID, resource.TypeRaw, resource.Size, resource.Status = selected.record.ID, selected.record.TypeRaw, selected.record.Size, selected.record.Status
		resource.DataIndex, resource.CreateTime, resource.AccessTime = selected.record.DataIndex, selected.record.CreateTime, selected.record.AccessTime
		resource.PackedInfoLength, resource.PackedInfoSHA256 = selected.record.PackedInfoLength, selected.record.PackedInfoSHA256
		resource.MatchingDetails = selected.matching
		return selected.data, selected.envelope, selected.guard, selected.proof, selected.mimeType, nil
	}
	if decoderFailure != "" {
		return nil, "", nil, emptyProof, "", notaloneFailure(decoderFailure)
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
	if mime := imageMIMEForExt(imageExtForData(data)); mime != "" || bytes.HasPrefix(data, []byte("wxgf")) {
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
		if err != nil || imageMIMEForExt(imageExtForData(decoded)) == "" && !bytes.HasPrefix(decoded, []byte("wxgf")) {
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

// 密钥走独立继承管道，绝不经普通 JSON 回执、日志、命令行或配置写入。
func (h *notaloneHistorySession) acceptImageRuntimeKey() error {
	fail := func() error { return notaloneFailure("history_image_key_unavailable") }
	if os.Getenv("NOTALONE_IMAGE_KEY_FD") != "3" || h.server.cfg == nil || h.selected == nil {
		return fail()
	}
	file := os.NewFile(3, "notalone-image-key")
	if file == nil {
		return fail()
	}
	defer file.Close()
	_ = file.SetReadDeadline(time.Now().Add(2 * time.Second))
	data, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil || len(data) == 0 || len(data) > 4096 {
		return fail()
	}
	defer func() {
		for i := range data {
			data[i] = 0
		}
	}()
	var supplied struct {
		Account    string `json:"accountKey"`
		RootSHA256 string `json:"rootSha256"`
		AESKey     string `json:"aesKey"`
		XORKey     *int   `json:"xorKey"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&supplied) != nil {
		return fail()
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return fail()
	}
	root, err := filepath.EvalSymlinks(h.server.cfg.DBRoot)
	rootSHA := sha256.Sum256([]byte(root))
	if err != nil || supplied.Account != h.selected.Account || supplied.Account != h.server.cfg.Wxid || supplied.RootSHA256 != hex.EncodeToString(rootSHA[:]) || supplied.XORKey == nil || *supplied.XORKey < 0 || *supplied.XORKey > 255 {
		return fail()
	}
	key, err := base64.StdEncoding.Strict().DecodeString(supplied.AESKey)
	if err != nil || len(key) != 16 {
		return fail()
	}
	defer func() {
		for i := range key {
			key[i] = 0
		}
	}()
	copyConfig := *h.server.cfg
	copyConfig.ImageKey = hex.EncodeToString(key)
	xor := *supplied.XORKey
	copyConfig.ImageXORKey = &xor
	h.imageRuntimeConfig = &copyConfig
	return nil
}

type notaloneImageOutput struct {
	bytes.Buffer
	limit int
}

func (b *notaloneImageOutput) Write(data []byte) (int, error) {
	if len(data) > b.limit-b.Len() {
		return 0, notaloneFailure("history_image_too_large")
	}
	return b.Buffer.Write(data)
}

func notaloneDecodeImageContent(ctx context.Context, source []byte) ([]byte, string, error) {
	if !bytes.HasPrefix(source, []byte("wxgf")) {
		return source, "none", nil
	}
	helper, expected := os.Getenv("NOTALONE_IMAGE_DECODER"), os.Getenv("NOTALONE_IMAGE_DECODER_SHA256")
	info, err := os.Lstat(helper)
	if err != nil || !filepath.IsAbs(helper) || filepath.Clean(helper) != helper || !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 || info.Mode().Perm()&0111 == 0 || info.Size() > 32<<20 || !notaloneImageDigestPattern.MatchString(expected) {
		return nil, "", notaloneFailure("history_image_decoder_unavailable")
	}
	binary, err := os.ReadFile(helper)
	if err != nil {
		return nil, "", notaloneFailure("history_image_decoder_unavailable")
	}
	digest := sha256.Sum256(binary)
	if hex.EncodeToString(digest[:]) != expected {
		return nil, "", notaloneFailure("history_image_decoder_unavailable")
	}
	file, err := os.CreateTemp("", "notalone-image-decode-*")
	if err != nil {
		return nil, "", notaloneFailure("history_image_read_failed")
	}
	defer file.Close()
	if os.Remove(file.Name()) != nil {
		return nil, "", notaloneFailure("history_image_read_failed")
	}
	if _, err = file.Write(source); err != nil {
		return nil, "", notaloneFailure("history_image_read_failed")
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return nil, "", notaloneFailure("history_image_read_failed")
	}
	bounded, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	command := exec.CommandContext(bounded, helper, "wxgf")
	command.ExtraFiles = []*os.File{file}
	command.Env = []string{"PATH=/usr/bin:/bin"}
	output := &notaloneImageOutput{limit: notaloneImageMaxBytes}
	command.Stdout = output
	if command.Run() != nil || bounded.Err() != nil || output.Len() == 0 || output.Len() > notaloneImageMaxBytes || !bytes.HasPrefix(output.Bytes(), []byte{137, 80, 78, 71, 13, 10, 26, 10}) {
		return nil, "", notaloneFailure("history_image_format_unsupported")
	}
	return output.Bytes(), "wxgf-to-png-v1", nil
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
