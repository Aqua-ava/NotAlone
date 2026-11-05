import Foundation

// HEVC Annex B 解析、按帧分组与 SPS 关键字段读取；供 WXGF 显示解码与合成夹具自测共用。
struct AnnexNAL {
    let type:Int
    let bytes:Data
}

func annexBStarts(_ bytes:[UInt8]) throws -> [(offset:Int,length:Int)] {
    var starts:[(offset:Int,length:Int)]=[]
    var cursor=0
    while cursor+3<bytes.count {
        if bytes[cursor]==0 && bytes[cursor+1]==0 && bytes[cursor+2]==0 && bytes[cursor+3]==1 {
            starts.append((cursor,4));cursor+=4
        } else if bytes[cursor]==0 && bytes[cursor+1]==0 && bytes[cursor+2]==1 {
            starts.append((cursor,3));cursor+=3
        } else {cursor+=1}
        guard starts.count<=8192 else {throw Failure("media_resource_limit")}
    }
    return starts
}

func annexBNAL(_ bytes:[UInt8],_ starts:[(offset:Int,length:Int)],at index:Int) throws -> AnnexNAL {
    let start=starts[index].offset+starts[index].length
    var end=index+1<starts.count ? starts[index+1].offset:bytes.count
    while end>start && bytes[end-1]==0 {end-=1}
    guard end-start>=2 else {throw Failure("media_image_invalid")}
    let unit=Data(bytes[start..<end])
    let type=(Int(unit[0])>>1)&0x3f
    guard unit[0]&0x80==0,unit[1]&0x07 != 0 else {throw Failure("media_image_invalid")}
    return AnnexNAL(type:type,bytes:unit)
}

func annexBUnits(_ data:Data) throws -> [AnnexNAL] {
    let bytes=[UInt8](data)
    let starts=try annexBStarts(bytes)
    guard starts.count>=4,starts.count<=8192 else {throw Failure("media_image_invalid")}
    var result:[AnnexNAL]=[]
    result.reserveCapacity(starts.count)
    for index in starts.indices {
        result.append(try annexBNAL(bytes,starts,at:index))
    }
    return result
}

func hasOrderedHEVCFrameUnits(_ units:[AnnexNAL]) -> Bool {
    var vps=false,sps=false,pps=false
    for unit in units {
        if unit.type==32 && !vps {vps=true}
        else if unit.type==33 && vps && !sps {sps=true}
        else if unit.type==34 && sps && !pps {pps=true}
        else if (0...31).contains(unit.type) {return pps}
    }
    return false
}

// AUD、填充与SEI不改变画面内容；分类时忽略，但仍要求参数集与切片的已核验顺序。
func isAuxiliaryHEVCNAL(_ type:Int) -> Bool {type==35 || type==38 || type==39 || type==40}

// 按VPS起点切帧：每帧自带参数集与切片，保持单帧流的原有解码路径。
// 首个VPS之前只允许附加信息单元，它们并入第一帧；其余前置单元仍拒绝。
func splitHEVCFrames(_ units:[AnnexNAL]) throws -> [[AnnexNAL]] {
    var frames:[[AnnexNAL]]=[]
    var current:[AnnexNAL]=[]
    var started=false
    for unit in units {
        if unit.type==32 {
            if started,!current.isEmpty {frames.append(current);current=[]}
            current.append(unit);started=true
        } else if started {
            current.append(unit)
        } else {
            guard isAuxiliaryHEVCNAL(unit.type) else {throw Failure("media_image_invalid")}
            current.append(unit)
        }
    }
    guard started,!current.isEmpty else {throw Failure("media_image_invalid")}
    frames.append(current)
    return frames
}

struct HEVCSPS {
    let chromaFormatIDC:Int
    let width:Int
    let height:Int
}

// 只读到判断色度格式与尺寸所需的字段；返回nil表示结构不完整或不可识别。
struct RBSPBits {
    let bytes:[UInt8]
    var index=0
    init(nal:Data) {
        let raw=[UInt8](nal)
        var rbsp:[UInt8]=[]
        rbsp.reserveCapacity(raw.count)
        var zeros=0
        for byte in raw.dropFirst(2) {
            if zeros==2 && byte==3 {zeros=0;continue}
            rbsp.append(byte)
            zeros=byte==0 ? zeros+1:0
        }
        bytes=rbsp
    }
    mutating func bit() -> Int? {
        guard index<bytes.count*8 else {return nil}
        let value=(Int(bytes[index/8])>>(7-index%8))&1
        index+=1
        return value
    }
    mutating func bits(_ count:Int) -> Int? {
        guard count>=0,count<=32 else {return nil}
        var value=0
        for _ in 0..<count {guard let next=bit() else {return nil};value=(value<<1)|next}
        return value
    }
    mutating func skip(_ count:Int) -> Bool {
        guard count>=0,count<=bytes.count*8-index else {return false}
        index+=count
        return true
    }
    mutating func ue() -> Int? {
        var zeros=0
        while true {
            guard let next=bit() else {return nil}
            if next==1 {break}
            zeros+=1
            guard zeros<=31 else {return nil}
        }
        guard let suffix=bits(zeros) else {return nil}
        return (1<<zeros)-1+suffix
    }
}

func skipProfileTierLevel(_ reader:inout RBSPBits,_ maxSubLayersMinus1:Int) -> Bool {
    guard reader.skip(88) else {return false}
    // profile_tier_level在通用profile之后、子层标志之前还有8位general_level_idc，漏掉会错位读取后续SPS字段。
    guard reader.skip(8) else {return false}
    if maxSubLayersMinus1>0 {
        var profiles:[Int]=[],levels:[Int]=[]
        profiles.reserveCapacity(maxSubLayersMinus1);levels.reserveCapacity(maxSubLayersMinus1)
        for _ in 0..<maxSubLayersMinus1 {
            guard let profile=reader.bit(),let level=reader.bit() else {return false}
            profiles.append(profile);levels.append(level)
        }
        guard reader.skip((8-maxSubLayersMinus1)*2) else {return false}
        for index in 0..<maxSubLayersMinus1 {
            if profiles[index]==1,!reader.skip(88) {return false}
            if levels[index]==1,!reader.skip(8) {return false}
        }
    }
    return true
}

func hevcSPSInfo(_ sps:Data) -> HEVCSPS? {
    guard sps.count>2 else {return nil}
    var reader=RBSPBits(nal:sps)
    guard reader.bits(4) != nil,let maxSubLayers=reader.bits(3),reader.bits(1) != nil else {return nil}
    guard skipProfileTierLevel(&reader,maxSubLayers) else {return nil}
    guard reader.ue() != nil else {return nil}
    guard let chroma=reader.ue(),(0...3).contains(chroma) else {return nil}
    if chroma==3,reader.bit()==nil {return nil}
    guard let width=reader.ue(),let height=reader.ue(),
          width>0,height>0,width<=40_000_000,height<=40_000_000 else {return nil}
    return HEVCSPS(chromaFormatIDC:chroma,width:width,height:height)
}

struct HEVCFrameInfo {
    let units:[AnnexNAL]
    let sps:HEVCSPS
}

// 多帧变体只接受已核验形态：VPS、SPS、PPS依次在前，随后是切片，且只有一个SPS/PPS。
func classifyHEVCFrame(_ units:[AnnexNAL]) throws -> HEVCFrameInfo {
    func unsupported() throws -> Never {throw Failure("media_format_unsupported")}
    // 附加信息单元（SEI等）不参与分类，但其余单元必须仍然刚好是VPS、SPS、PPS与切片。
    let meaningful=units.filter{!isAuxiliaryHEVCNAL($0.type)}
    guard meaningful.first?.type==32,
          meaningful.filter({$0.type==32}).count==1,
          meaningful.filter({$0.type==33}).count==1,
          meaningful.filter({$0.type==34}).count==1 else {try unsupported()}
    var phase=0
    for unit in meaningful {
        switch unit.type {
        case 32:
            guard phase==0 else {try unsupported()}
            phase=1
        case 33:
            guard phase==1 else {try unsupported()}
            phase=2
        case 34:
            guard phase==2 else {try unsupported()}
            phase=3
        default:
            guard (0...31).contains(unit.type),phase==3 else {try unsupported()}
        }
    }
    guard phase==3,let spsUnit=meaningful.first(where:{$0.type==33}),let sps=hevcSPSInfo(spsUnit.bytes) else {try unsupported()}
    return HEVCFrameInfo(units:units,sps:sps)
}

// 双帧变体必须是同尺寸的一帧彩色加一帧单色透明度；其余多帧形态明确报不支持。
func classifyDualHEVCFrames(_ frames:[[AnnexNAL]]) throws -> (color:HEVCFrameInfo,alpha:HEVCFrameInfo) {
    guard frames.count==2 else {throw Failure("media_format_unsupported")}
    let first=try classifyHEVCFrame(frames[0])
    let second=try classifyHEVCFrame(frames[1])
    guard (first.sps.chromaFormatIDC==0) != (second.sps.chromaFormatIDC==0),
          first.sps.width==second.sps.width,first.sps.height==second.sps.height else {
        throw Failure("media_format_unsupported")
    }
    return first.sps.chromaFormatIDC==0 ? (color:second,alpha:first):(color:first,alpha:second)
}
