package main

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"sort"
)

const (
	notaloneDeltaPageSize     = 4096
	notaloneDeltaReserveSize  = 80
	notaloneDeltaPlainFormat  = "sqlite-wal-rowid-page-v1"
	notaloneDeltaIVSize       = 16
	notaloneDeltaHMACSize     = 64
	notaloneDeltaMaxPages     = 131072
	notaloneDeltaMaxRowIDs    = 1 << 20
	notaloneDeltaMaxWALBytes  = 512 << 20
	notaloneDeltaFormat       = "sqlcipher4-wal-rowid-page-v1"
	notaloneDeltaWALFormat    = 3007000
	notaloneDeltaWALMagicLE   = 0x377f0682
	notaloneDeltaWALMagicBE   = 0x377f0683
	notaloneDeltaPageInterior = 5
	notaloneDeltaPageLeaf     = 13
	notaloneDeltaPageOverflow = 255
)

type notaloneDeltaPageState struct {
	Format      string                     `json:"format"`
	PageSize    uint32                     `json:"pageSize"`
	ReserveSize uint32                     `json:"reserveSize"`
	RootPage    uint32                     `json:"rootPage"`
	SaltDigest  string                     `json:"saltDigest"`
	PageCount   uint32                     `json:"pageCount"`
	WAL         notaloneDeltaWALState      `json:"wal"`
	Pages       []notaloneDeltaTrackedPage `json:"pages"`
}

type notaloneDeltaWALState struct {
	HeaderDigest string `json:"headerDigest,omitempty"`
	Salt1        uint32 `json:"salt1,omitempty"`
	Salt2        uint32 `json:"salt2,omitempty"`
	CommitOffset int64  `json:"commitOffset,omitempty"`
	Checksum1    uint32 `json:"checksum1,omitempty"`
	Checksum2    uint32 `json:"checksum2,omitempty"`
}

type notaloneDeltaTrackedPage struct {
	Number        uint32                       `json:"number"`
	Parent        uint32                       `json:"parent,omitempty"`
	Hash          string                       `json:"hash"`
	Kind          uint8                        `json:"kind"`
	RowIDs        []int64                      `json:"rowIds,omitempty"`
	ChildPages    []uint32                     `json:"childPages,omitempty"`
	OverflowHeads []notaloneDeltaOverflowOwner `json:"overflowHeads,omitempty"`
	OverflowPages []uint32                     `json:"overflowPages,omitempty"`
	OverflowNext  uint32                       `json:"overflowNext,omitempty"`
}

type notaloneDeltaOverflowOwner struct {
	RowID     int64  `json:"rowId"`
	HeadPage  uint32 `json:"headPage"`
	PageCount uint32 `json:"pageCount"`
}

type notaloneDeltaPageResult struct {
	State      notaloneDeltaPageState
	ChangedIDs []int64
	FullAudit  bool
	Baseline   bool
}

type notaloneDeltaFrame struct {
	Page   uint32
	Offset int64
}

type notaloneDeltaWALScan struct {
	State         notaloneDeltaWALState
	PageCount     uint32
	Frames        map[uint32]notaloneDeltaFrame
	AllFrames     map[uint32]notaloneDeltaFrame
	LastCommitEnd int64
	LastChecksum1 uint32
	LastChecksum2 uint32
	HasWAL        bool
	Continuous    bool
	FramesRead    uint32
}

type notaloneDeltaCrypto struct {
	key     []byte
	hmacKey []byte
	salt    [16]byte
	plain   bool
}

type notaloneDeltaPageReader struct {
	ctx         context.Context
	db          io.ReaderAt
	dbSize      int64
	wal         io.ReaderAt
	walSize     int64
	walFrames   map[uint32]notaloneDeltaFrame
	pageCount   uint32
	reserveSize uint32
	format      string
	crypto      notaloneDeltaCrypto
}

type notaloneDeltaNode struct {
	kind          uint8
	rowIDs        []int64
	children      []uint32
	overflowHeads []notaloneDeltaOverflowOwner
	overflowCount map[int64]uint32
}

func readNotaloneDeltaPages(ctx context.Context, db io.ReaderAt, dbSize int64, wal io.ReaderAt, walSize int64,
	rootPage uint32, rawKey []byte, prior *notaloneDeltaPageState, walIndex ...notaloneDeltaWALIndexReader) (*notaloneDeltaPageResult, error) {
	if ctx == nil || db == nil || rootPage < 2 || (len(rawKey) != 0 && len(rawKey) != 32) || dbSize < 0 || dbSize%notaloneDeltaPageSize != 0 {
		return nil, errors.New("history_delta_request_invalid")
	}
	if dbSize/notaloneDeltaPageSize > notaloneDeltaMaxPages || walSize < 0 || walSize > notaloneDeltaMaxWALBytes {
		return nil, errors.New("history_delta_source_limit")
	}
	key := append([]byte(nil), rawKey...)
	defer clear(key)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	basePageCount := uint32(dbSize / notaloneDeltaPageSize)
	if basePageCount > notaloneDeltaMaxPages {
		return nil, errors.New("history_delta_source_limit")
	}
	walScan, err := notaloneDeltaScanWAL(ctx, wal, walSize, prior, walIndex...)
	if err != nil {
		return nil, err
	}
	pageCount := basePageCount
	if walScan.HasWAL && walScan.PageCount > 0 {
		pageCount = walScan.PageCount
	}
	if pageCount == 0 || pageCount > notaloneDeltaMaxPages || rootPage > pageCount {
		return nil, errors.New("history_delta_page_count_invalid")
	}
	pageReader := &notaloneDeltaPageReader{ctx: ctx, db: db, dbSize: dbSize, wal: wal, walSize: walSize,
		walFrames: walScan.AllFrames, pageCount: pageCount}
	page1, err := pageReader.readRawPage(1)
	if err != nil {
		return nil, err
	}
	copy(pageReader.crypto.salt[:], page1[:16])
	if bytes.Equal(page1[:16], []byte("SQLite format 3\x00")) {
		if len(key) != 0 || binary.BigEndian.Uint16(page1[16:18]) != notaloneDeltaPageSize {
			clear(page1)
			return nil, errors.New("history_delta_plain_header_invalid")
		}
		pageReader.reserveSize = uint32(page1[20])
		if pageReader.reserveSize > notaloneDeltaPageSize-35 {
			clear(page1)
			return nil, errors.New("history_delta_plain_reserve_invalid")
		}
		pageReader.format = notaloneDeltaPlainFormat
		pageReader.crypto.plain = true
	} else {
		if len(key) != 32 || allZero(pageReader.crypto.salt[:]) {
			clear(page1)
			return nil, errors.New("history_delta_salt_invalid")
		}
		pageReader.reserveSize = notaloneDeltaReserveSize
		pageReader.format = notaloneDeltaFormat
		pageReader.crypto.key = key
		pageReader.crypto.hmacKey = notaloneDeltaHMACKey(key, pageReader.crypto.salt[:])
		defer clear(pageReader.crypto.hmacKey)
	}
	clear(page1)
	saltDigest := sha256.Sum256(pageReader.crypto.salt[:])
	newSaltDigest := hex.EncodeToString(saltDigest[:])

	if prior != nil && !notaloneDeltaPriorValid(*prior, rootPage, newSaltDigest, pageReader.format, pageReader.reserveSize) {
		return nil, errors.New("history_delta_checkpoint_invalid")
	}
	continuous := prior != nil && walScan.HasWAL && walScan.Continuous && prior.WAL.HeaderDigest == walScan.State.HeaderDigest &&
		prior.WAL.CommitOffset <= walSize
	if continuous {
		pageReader.walFrames = walScan.Frames
		pageReader.pageCount = pageCount
		if len(walScan.Frames) == 0 {
			state := *prior
			state.Pages = notaloneDeltaCloneTrackedPages(prior.Pages)
			state.WAL = walScan.State
			return &notaloneDeltaPageResult{State: state}, nil
		}
		state, changed, updateErr := notaloneDeltaApplyWALFrames(ctx, pageReader, rootPage, *prior, walScan)
		if updateErr != nil {
			return nil, updateErr
		}
		state.SaltDigest = newSaltDigest
		return &notaloneDeltaPageResult{State: state, ChangedIDs: notaloneDeltaSortIDs(changed), Baseline: false}, nil
	}

	pageReader.walFrames = walScan.AllFrames
	pageReader.pageCount = pageCount
	pages, err := notaloneDeltaWalkFull(ctx, pageReader, rootPage)
	if err != nil {
		return nil, err
	}
	state := notaloneDeltaPageState{Format: pageReader.format, PageSize: notaloneDeltaPageSize,
		ReserveSize: pageReader.reserveSize, RootPage: rootPage, SaltDigest: newSaltDigest,
		PageCount: pageCount, WAL: walScan.State, Pages: notaloneDeltaSortedPages(pages)}
	if !notaloneDeltaPriorValid(state, rootPage, newSaltDigest, pageReader.format, pageReader.reserveSize) {
		return nil, errors.New("history_delta_state_invalid_after_audit")
	}
	changed := map[int64]struct{}{}
	if prior == nil {
		for _, page := range state.Pages {
			if page.Kind == notaloneDeltaPageLeaf {
				for _, id := range page.RowIDs {
					changed[id] = struct{}{}
				}
			}
		}
	} else {
		notaloneDeltaComparePageStates(*prior, state, changed)
	}
	return &notaloneDeltaPageResult{State: state, ChangedIDs: notaloneDeltaSortIDs(changed), FullAudit: prior != nil, Baseline: prior == nil}, nil
}

func notaloneDeltaPriorValid(prior notaloneDeltaPageState, rootPage uint32, saltDigest, format string, reserveSize uint32) bool {
	if prior.Format != format || prior.PageSize != notaloneDeltaPageSize || prior.ReserveSize != reserveSize ||
		prior.RootPage != rootPage || prior.SaltDigest != saltDigest || prior.PageCount == 0 || prior.PageCount > notaloneDeltaMaxPages ||
		len(prior.Pages) == 0 || len(prior.Pages) > notaloneDeltaMaxPages {
		return false
	}
	if len(prior.SaltDigest) != sha256.Size*2 {
		return false
	}
	if prior.WAL.HeaderDigest == "" {
		if prior.WAL.CommitOffset != 0 || prior.WAL.Salt1 != 0 || prior.WAL.Salt2 != 0 || prior.WAL.Checksum1 != 0 || prior.WAL.Checksum2 != 0 {
			return false
		}
	} else if len(prior.WAL.HeaderDigest) != sha256.Size*2 || prior.WAL.CommitOffset < notaloneDeltaWALHeaderSize {
		return false
	} else if _, err := hex.DecodeString(prior.WAL.HeaderDigest); err != nil {
		return false
	}
	seen := make(map[uint32]notaloneDeltaTrackedPage, len(prior.Pages))
	rowIDs := make(map[int64]struct{})
	for _, page := range prior.Pages {
		if page.Number == 0 || page.Number > prior.PageCount || len(page.Hash) != sha256.Size*2 ||
			(page.Kind != notaloneDeltaPageInterior && page.Kind != notaloneDeltaPageLeaf && page.Kind != notaloneDeltaPageOverflow) {
			return false
		}
		if _, err := hex.DecodeString(page.Hash); err != nil {
			return false
		}
		if _, ok := seen[page.Number]; ok {
			return false
		}
		seen[page.Number] = page
		if len(page.RowIDs) > notaloneDeltaMaxRowIDs || len(page.ChildPages) > notaloneDeltaMaxPages || len(page.OverflowHeads) > notaloneDeltaMaxRowIDs || len(page.OverflowPages) > notaloneDeltaMaxPages {
			return false
		}
		if page.Kind == notaloneDeltaPageLeaf {
			if len(page.ChildPages) != 0 || page.OverflowNext != 0 {
				return false
			}
			for _, id := range page.RowIDs {
				if _, ok := rowIDs[id]; ok {
					return false
				}
				rowIDs[id] = struct{}{}
			}
		} else if page.Kind == notaloneDeltaPageInterior {
			if len(page.RowIDs) != 0 || len(page.OverflowHeads) != 0 || len(page.OverflowPages) != 0 || page.OverflowNext != 0 || len(page.ChildPages) == 0 {
				return false
			}
		} else if len(page.RowIDs) != 1 || len(page.ChildPages) != 0 || len(page.OverflowHeads) != 0 || len(page.OverflowPages) != 0 || page.OverflowNext > prior.PageCount {
			return false
		}
	}
	root, ok := seen[rootPage]
	if !ok || root.Parent != 0 || (root.Kind != notaloneDeltaPageInterior && root.Kind != notaloneDeltaPageLeaf) {
		return false
	}
	visited := make(map[uint32]bool, len(seen))
	stack := []uint32{rootPage}
	for len(stack) > 0 {
		last := len(stack) - 1
		number := stack[last]
		stack = stack[:last]
		if visited[number] {
			return false
		}
		visited[number] = true
		page := seen[number]
		if page.Kind == notaloneDeltaPageInterior {
			children := make(map[uint32]struct{}, len(page.ChildPages))
			for _, child := range page.ChildPages {
				childPage, exists := seen[child]
				if !exists || childPage.Parent != number || (childPage.Kind != notaloneDeltaPageInterior && childPage.Kind != notaloneDeltaPageLeaf) {
					return false
				}
				if _, duplicate := children[child]; duplicate {
					return false
				}
				children[child] = struct{}{}
				stack = append(stack, child)
			}
		} else {
			leafOverflow := make(map[uint32]struct{}, len(page.OverflowPages))
			for _, overflow := range page.OverflowPages {
				if _, duplicate := leafOverflow[overflow]; duplicate {
					return false
				}
				leafOverflow[overflow] = struct{}{}
			}
			used := make(map[uint32]struct{}, len(page.OverflowPages))
			ownerIDs := make(map[int64]struct{}, len(page.OverflowHeads))
			for _, owner := range page.OverflowHeads {
				if owner.HeadPage == 0 || owner.PageCount == 0 || owner.PageCount > notaloneDeltaMaxPages || owner.HeadPage > prior.PageCount {
					return false
				}
				if _, exists := rowIDs[owner.RowID]; !exists {
					return false
				}
				if _, duplicate := ownerIDs[owner.RowID]; duplicate {
					return false
				}
				ownerIDs[owner.RowID] = struct{}{}
				current := owner.HeadPage
				for index := uint32(0); index < owner.PageCount; index++ {
					overflowPage, exists := seen[current]
					if !exists || overflowPage.Kind != notaloneDeltaPageOverflow || overflowPage.Parent != number || len(overflowPage.RowIDs) != 1 || overflowPage.RowIDs[0] != owner.RowID {
						return false
					}
					if _, duplicate := used[current]; duplicate {
						return false
					}
					used[current] = struct{}{}
					if index+1 == owner.PageCount {
						if overflowPage.OverflowNext != 0 {
							return false
						}
					} else {
						if overflowPage.OverflowNext == 0 {
							return false
						}
						current = overflowPage.OverflowNext
					}
				}
			}
			if len(used) != len(leafOverflow) {
				return false
			}
			for overflow := range leafOverflow {
				if _, exists := used[overflow]; !exists {
					return false
				}
				visited[overflow] = true
			}
		}
	}
	return len(visited) == len(seen)
}

func notaloneDeltaSortedPages(pages map[uint32]notaloneDeltaTrackedPage) []notaloneDeltaTrackedPage {
	result := make([]notaloneDeltaTrackedPage, 0, len(pages))
	for _, page := range pages {
		page.RowIDs = append([]int64(nil), page.RowIDs...)
		page.ChildPages = append([]uint32(nil), page.ChildPages...)
		page.OverflowHeads = append([]notaloneDeltaOverflowOwner(nil), page.OverflowHeads...)
		page.OverflowPages = append([]uint32(nil), page.OverflowPages...)
		result = append(result, page)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Number < result[j].Number })
	return result
}

func notaloneDeltaSortIDs(ids map[int64]struct{}) []int64 {
	result := make([]int64, 0, len(ids))
	for id := range ids {
		result = append(result, id)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}

func notaloneDeltaComparePageStates(oldState, newState notaloneDeltaPageState, changed map[int64]struct{}) {
	oldPages := make(map[uint32]notaloneDeltaTrackedPage, len(oldState.Pages))
	newPages := make(map[uint32]notaloneDeltaTrackedPage, len(newState.Pages))
	for _, page := range oldState.Pages {
		oldPages[page.Number] = page
	}
	for _, page := range newState.Pages {
		newPages[page.Number] = page
	}
	for number, oldPage := range oldPages {
		current, ok := newPages[number]
		if ok && oldPage.Hash == current.Hash && oldPage.Kind == current.Kind {
			continue
		}
		notaloneDeltaAddPageOwners(oldPage, changed)
		if ok {
			notaloneDeltaAddPageOwners(current, changed)
		}
	}
	for number, current := range newPages {
		if _, ok := oldPages[number]; !ok {
			notaloneDeltaAddPageOwners(current, changed)
		}
	}
}

func notaloneDeltaAddPageOwners(page notaloneDeltaTrackedPage, changed map[int64]struct{}) {
	if page.Kind != notaloneDeltaPageLeaf && page.Kind != notaloneDeltaPageOverflow {
		return
	}
	for _, id := range page.RowIDs {
		changed[id] = struct{}{}
	}
}

func notaloneDeltaReadAt(ctx context.Context, reader io.ReaderAt, target []byte, offset int64) error {
	if ctx == nil || reader == nil || offset < 0 {
		return errors.New("history_delta_read_invalid")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	read, err := reader.ReadAt(target, offset)
	if err != nil && !(err == io.EOF && read == len(target)) {
		return errors.New("history_delta_short_read")
	}
	if read != len(target) {
		return errors.New("history_delta_short_read")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return nil
}

func (reader *notaloneDeltaPageReader) readRawPage(page uint32) ([]byte, error) {
	if page == 0 || page > notaloneDeltaMaxPages || (reader.pageCount != 0 && page > reader.pageCount) {
		return nil, errors.New("history_delta_page_invalid")
	}
	data := make([]byte, notaloneDeltaPageSize)
	if frame, ok := reader.walFrames[page]; ok {
		if reader.wal == nil {
			return nil, errors.New("history_delta_wal_frame_missing")
		}
		if err := notaloneDeltaReadAt(reader.ctx, reader.wal, data, frame.Offset+24); err != nil {
			clear(data)
			return nil, err
		}
		return data, nil
	}
	offset := int64(page-1) * notaloneDeltaPageSize
	if offset+notaloneDeltaPageSize > reader.dbSize {
		clear(data)
		return nil, errors.New("history_delta_page_missing")
	}
	if err := notaloneDeltaReadAt(reader.ctx, reader.db, data, offset); err != nil {
		clear(data)
		return nil, err
	}
	return data, nil
}

func notaloneDeltaHMACKey(rawKey, salt []byte) []byte {
	maskedSalt := append([]byte(nil), salt...)
	for i := range maskedSalt {
		maskedSalt[i] ^= 0x3a
	}
	defer clear(maskedSalt)
	return notaloneDeltaPBKDF2SHA512(rawKey, maskedSalt, 2, 32)
}

func notaloneDeltaPBKDF2SHA512(password, salt []byte, iterations, length int) []byte {
	if iterations < 1 || length < 1 {
		return nil
	}
	const blockSize = sha512.Size
	blocks := (length + blockSize - 1) / blockSize
	out := make([]byte, length)
	written := 0
	var index [4]byte
	for block := 1; block <= blocks; block++ {
		binary.BigEndian.PutUint32(index[:], uint32(block))
		mac := hmac.New(sha512.New, password)
		_, _ = mac.Write(salt)
		_, _ = mac.Write(index[:])
		u := mac.Sum(nil)
		t := append([]byte(nil), u...)
		for round := 1; round < iterations; round++ {
			mac = hmac.New(sha512.New, password)
			_, _ = mac.Write(u)
			clear(u)
			u = mac.Sum(nil)
			for i := range t {
				t[i] ^= u[i]
			}
		}
		count := len(t)
		if count > length-written {
			count = length - written
		}
		copy(out[written:written+count], t[:count])
		written += count
		clear(u)
		clear(t)
	}
	return out
}

func notaloneDeltaDecryptPage(raw []byte, page uint32, cryptoState *notaloneDeltaCrypto) ([]byte, error) {
	if len(raw) != notaloneDeltaPageSize || page == 0 || cryptoState == nil {
		return nil, errors.New("history_delta_cipher_page_invalid")
	}
	if cryptoState.plain {
		return append([]byte(nil), raw...), nil
	}
	if len(cryptoState.key) != 32 || len(cryptoState.hmacKey) != 32 {
		return nil, errors.New("history_delta_cipher_page_invalid")
	}
	start := 0
	if page == 1 {
		start = 16
		if !hmac.Equal(raw[:16], cryptoState.salt[:]) {
			return nil, errors.New("history_delta_cipher_salt_mismatch")
		}
	}
	cipherEnd := notaloneDeltaPageSize - notaloneDeltaReserveSize
	ivOffset := cipherEnd
	hmacOffset := pageSizeHMACOffset()
	mac := hmac.New(sha512.New, cryptoState.hmacKey)
	_, _ = mac.Write(raw[start:hmacOffset])
	var pageNumber [4]byte
	binary.LittleEndian.PutUint32(pageNumber[:], page)
	_, _ = mac.Write(pageNumber[:])
	expected := mac.Sum(nil)
	valid := hmac.Equal(expected, raw[hmacOffset:])
	clear(expected)
	if !valid {
		return nil, errors.New("history_delta_cipher_hmac_invalid")
	}
	if cipherEnd-start <= 0 || (cipherEnd-start)%aes.BlockSize != 0 {
		return nil, errors.New("history_delta_cipher_layout_invalid")
	}
	block, err := aes.NewCipher(cryptoState.key)
	if err != nil {
		return nil, errors.New("history_delta_cipher_unavailable")
	}
	plain := make([]byte, notaloneDeltaPageSize)
	if page == 1 {
		copy(plain, "SQLite format 3\x00")
	}
	cbc := cipher.NewCBCDecrypter(block, raw[ivOffset:ivOffset+notaloneDeltaIVSize])
	cbc.CryptBlocks(plain[start:cipherEnd], raw[start:cipherEnd])
	return plain, nil
}

func pageSizeHMACOffset() int { return notaloneDeltaPageSize - notaloneDeltaHMACSize }

func allZero(data []byte) bool {
	var x byte
	for _, value := range data {
		x |= value
	}
	return x == 0
}

func notaloneDeltaChecksum(data []byte, little bool, first, second uint32) (uint32, uint32, error) {
	if len(data)%8 != 0 {
		return 0, 0, errors.New("history_delta_wal_checksum_length")
	}
	for offset := 0; offset < len(data); offset += 8 {
		var left, right uint32
		if little {
			left = binary.LittleEndian.Uint32(data[offset : offset+4])
			right = binary.LittleEndian.Uint32(data[offset+4 : offset+8])
		} else {
			left = binary.BigEndian.Uint32(data[offset : offset+4])
			right = binary.BigEndian.Uint32(data[offset+4 : offset+8])
		}
		first += left + second
		second += right + first
	}
	return first, second, nil
}

func notaloneDeltaChecksumFields(data []byte) (uint32, uint32) {
	return binary.BigEndian.Uint32(data), binary.BigEndian.Uint32(data[4:])
}

func notaloneDeltaHash(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}
