import Foundation
import ImageIO
import CoreGraphics
import CoreMedia
import CoreVideo
import VideoToolbox

private let wxgfPrefix=Data("wxgf".utf8)
private let wxgfStartCode=[UInt8](arrayLiteral:0,0,0,1)
private let wxgfOutputLimit=32*1024*1024
private let wxgfPixelLimit=40_000_000

private struct AnnexNAL {
    let type:Int
    let bytes:Data
}

private func annexBUnits(_ data:Data) throws -> [AnnexNAL] {
    let bytes=[UInt8](data)
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
    guard starts.count>=4,starts.count<=8192 else {throw Failure("media_image_invalid")}
    var result:[AnnexNAL]=[]
    result.reserveCapacity(starts.count)
    for index in starts.indices {
        let start=starts[index].offset+starts[index].length
        var end=index+1<starts.count ? starts[index+1].offset:bytes.count
        while end>start && bytes[end-1]==0 {end-=1}
        guard end-start>=2 else {throw Failure("media_image_invalid")}
        let unit=Data(bytes[start..<end])
        let type=(Int(unit[0])>>1)&0x3f
        guard unit[0]&0x80==0 else {throw Failure("media_image_invalid")}
        result.append(AnnexNAL(type:type,bytes:unit))
    }
    return result
}

private func png(_ image:CGImage) throws -> Data {
    guard image.width>0,image.height>0,image.width<=40_000_000,image.height<=40_000_000 else {
        throw Failure("media_image_invalid")
    }
    let (pixels,overflow)=image.width.multipliedReportingOverflow(by:image.height)
    guard !overflow,pixels<=wxgfPixelLimit else {throw Failure("media_resource_limit")}
    let output=NSMutableData()
    guard let destination=CGImageDestinationCreateWithData(output,"public.png" as CFString,1,nil) else {
        throw Failure("media_validation_failed")
    }
    CGImageDestinationAddImage(destination,image,nil)
    guard CGImageDestinationFinalize(destination),output.length>0,output.length<=wxgfOutputLimit else {
        throw output.length>wxgfOutputLimit ? Failure("media_resource_too_large"):Failure("media_image_invalid")
    }
    let result=output as Data
    _=try imageMetadata(result)
    return result
}

private func imageMetadata(_ data:Data) throws -> [String:Any] {
    let options=[kCGImageSourceShouldCache:false] as CFDictionary
    guard let source=CGImageSourceCreateWithData(data as CFData,options),
          let type=CGImageSourceGetType(source) as String?,type=="public.png",
          try imageContainer(data,format:"png")==1,
          CGImageSourceGetCount(source)==1,
          CGImageSourceGetStatus(source) == .statusComplete,
          let properties=CGImageSourceCopyPropertiesAtIndex(source,0,nil) as? [String:Any],
          let width=properties[kCGImagePropertyPixelWidth as String] as? Int,
          let height=properties[kCGImagePropertyPixelHeight as String] as? Int,
          let decoded=CGImageSourceCreateImageAtIndex(source,0,[kCGImageSourceShouldCacheImmediately:true] as CFDictionary),
          decoded.width==width,decoded.height==height,CGImageSourceGetStatusAtIndex(source,0) == .statusComplete else {
        throw Failure("media_image_invalid")
    }
    guard width>0,height>0,Int64(width)*Int64(height)<=Int64(wxgfPixelLimit) else {
        throw Failure("media_resource_limit")
    }
    return ["format":"png","mimeType":"image/png","containerValid":true,"viewable":true,"playable":false]
}

private final class DecodedFrames: @unchecked Sendable {
    private let lock=NSLock()
    private var values:[CVImageBuffer]=[]
    private var error:OSStatus=noErr
    func append(_ image:CVImageBuffer?,status:OSStatus) {
        lock.lock();defer {lock.unlock()}
        if status != noErr {error=status;return}
        if let image {values.append(image)} else {error=OSStatus(paramErr)}
    }
    func result() -> (frames:[CVImageBuffer],error:OSStatus) {
        lock.lock();defer {lock.unlock()}
        return (values,error)
    }
}

private func decodeHEVC(_ units:[AnnexNAL]) throws -> CGImage {
    let parameterSets=units.filter{(32...34).contains($0.type)}
    let slices=units.filter{(0...31).contains($0.type)}
    guard parameterSets.count>=3,parameterSets.contains(where:{$0.type==32}),
          parameterSets.contains(where:{$0.type==33}),parameterSets.contains(where:{$0.type==34}),
          !slices.isEmpty else {throw Failure("media_image_invalid")}

    let owned=parameterSets.map{unit -> UnsafeMutablePointer<UInt8> in
        let pointer=UnsafeMutablePointer<UInt8>.allocate(capacity:unit.bytes.count)
        unit.bytes.copyBytes(to:pointer,count:unit.bytes.count)
        return pointer
    }
    defer {owned.forEach{$0.deallocate()}}
    let pointers:[UnsafePointer<UInt8>]=owned.map{UnsafePointer($0)}
    let sizes=parameterSets.map{unit in unit.bytes.count}
    var description:CMFormatDescription?
    let descriptionStatus=CMVideoFormatDescriptionCreateFromHEVCParameterSets(
        allocator:kCFAllocatorDefault,parameterSetCount:parameterSets.count,
        parameterSetPointers:pointers,parameterSetSizes:sizes,nalUnitHeaderLength:4,
        extensions:nil,formatDescriptionOut:&description)
    guard descriptionStatus==noErr,let description else {throw Failure("media_image_invalid")}
    let dimensions=CMVideoFormatDescriptionGetDimensions(description)
    let pixelCount=Int64(dimensions.width)*Int64(dimensions.height)
    guard dimensions.width>0,dimensions.height>0,pixelCount<=Int64(wxgfPixelLimit) else {
        throw Failure("media_resource_limit")
    }

    var framed=Data()
    for unit in slices {
        guard unit.bytes.count<=Int(UInt32.max),unit.bytes.count<=maxBytes-4,framed.count<=maxBytes-4-unit.bytes.count else {
            throw Failure("media_resource_too_large")
        }
        var length=UInt32(unit.bytes.count).bigEndian
        withUnsafeBytes(of:&length){framed.append(contentsOf:$0)}
        framed.append(unit.bytes)
    }
    guard !framed.isEmpty else {throw Failure("media_image_invalid")}
    var block:CMBlockBuffer?
    let blockStatus=CMBlockBufferCreateWithMemoryBlock(
        allocator:kCFAllocatorDefault,memoryBlock:nil,blockLength:framed.count,
        blockAllocator:kCFAllocatorDefault,customBlockSource:nil,offsetToData:0,
        dataLength:framed.count,flags:0,blockBufferOut:&block)
    guard blockStatus==kCMBlockBufferNoErr,let block else {throw Failure("media_image_invalid")}
    let copyStatus=framed.withUnsafeBytes { raw -> OSStatus in
        guard let base=raw.baseAddress else {return OSStatus(paramErr)}
        return CMBlockBufferReplaceDataBytes(with:base,blockBuffer:block,offsetIntoDestination:0,dataLength:framed.count)
    }
    guard copyStatus==kCMBlockBufferNoErr else {throw Failure("media_image_invalid")}

    var timing=CMSampleTimingInfo(duration:CMTime(value:1,timescale:30),presentationTimeStamp:.zero,decodeTimeStamp:.invalid)
    var sampleSize=framed.count
    var sample:CMSampleBuffer?
    let sampleStatus=CMSampleBufferCreateReady(
        allocator:kCFAllocatorDefault,dataBuffer:block,formatDescription:description,sampleCount:1,
        sampleTimingEntryCount:1,sampleTimingArray:&timing,sampleSizeEntryCount:1,
        sampleSizeArray:&sampleSize,sampleBufferOut:&sample)
    guard sampleStatus==noErr,let sample,CMSampleBufferDataIsReady(sample) else {throw Failure("media_image_invalid")}

    let attributes:[CFString:Any]=[
        kCVPixelBufferPixelFormatTypeKey:kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey:Int(dimensions.width),kCVPixelBufferHeightKey:Int(dimensions.height),
        kCVPixelBufferIOSurfacePropertiesKey:[:]
    ]
    var session:VTDecompressionSession?
    guard VTDecompressionSessionCreate(
        allocator:kCFAllocatorDefault,formatDescription:description,decoderSpecification:nil,
        imageBufferAttributes:attributes as CFDictionary,outputCallback:nil,
        decompressionSessionOut:&session)==noErr,let session else {throw Failure("media_format_unsupported")}
    defer {VTDecompressionSessionInvalidate(session)}

    let decoded=DecodedFrames()
    var flags=VTDecodeInfoFlags()
    let status=VTDecompressionSessionDecodeFrame(session,sampleBuffer:sample,flags:[],infoFlagsOut:&flags) {
        status,_,image,_,_ in decoded.append(image,status:status)
    }
    guard status==noErr else {throw Failure("media_image_invalid")}
    let result=decoded.result()
    guard result.error==noErr,result.frames.count==1,let frame=result.frames.first,
          Int64(CVPixelBufferGetWidth(frame))*Int64(CVPixelBufferGetHeight(frame))<=Int64(wxgfPixelLimit) else {
        throw Failure("media_image_invalid")
    }
    var cgImage:CGImage?
    guard VTCreateCGImageFromCVPixelBuffer(frame,options:nil,imageOut:&cgImage)==noErr,
          let cgImage,cgImage.width==Int(dimensions.width),cgImage.height==Int(dimensions.height) else {
        throw Failure("media_image_invalid")
    }
    return cgImage
}

func decodeWxgf(_ data:Data) throws -> Data {
    guard data.count>=4,data.count<=maxBytes,data.prefix(4)==wxgfPrefix else {throw Failure("media_format_unsupported")}
    let payload=data.dropFirst(4)
    let jpeg=Data([0xff,0xd8,0xff])
    let pngHeader=Data([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])
    let hevc=try? annexBUnits(Data(payload))
    if let hevc,hevc.contains(where:{$0.type==32}),hevc.contains(where:{$0.type==33}),
       hevc.contains(where:{$0.type==34}),hevc.contains(where:{(0...31).contains($0.type)}) {
        return try png(decodeHEVC(hevc))
    }
    if let range=payload.range(of:jpeg) {
        let encoded=Data(payload[range.lowerBound..<payload.endIndex])
        guard encoded.suffix(2)==Data([0xff,0xd9]) else {throw Failure("media_image_invalid")}
        guard let source=CGImageSourceCreateWithData(encoded as CFData,nil),CGImageSourceGetCount(source)==1,
              CGImageSourceGetStatus(source) == .statusComplete,
              let image=CGImageSourceCreateImageAtIndex(source,0,[kCGImageSourceShouldCacheImmediately:true] as CFDictionary),
              CGImageSourceGetStatusAtIndex(source,0) == .statusComplete else {throw Failure("media_image_invalid")}
        return try png(image)
    }
    if let range=payload.range(of:pngHeader) {
        let encoded=Data(payload[range.lowerBound..<payload.endIndex])
        guard try imageContainer(encoded,format:"png")==1,
              let source=CGImageSourceCreateWithData(encoded as CFData,nil),CGImageSourceGetCount(source)==1,
              CGImageSourceGetStatus(source) == .statusComplete,
              let image=CGImageSourceCreateImageAtIndex(source,0,[kCGImageSourceShouldCacheImmediately:true] as CFDictionary),
              CGImageSourceGetStatusAtIndex(source,0) == .statusComplete else {throw Failure("media_image_invalid")}
        return try png(image)
    }
    let units=try annexBUnits(Data(payload))
    return try png(decodeHEVC(units))
}
