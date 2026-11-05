import Foundation
import ImageIO
import CoreGraphics
import CoreMedia
import CoreVideo
import VideoToolbox

private let wxgfPrefix=Data("wxgf".utf8)
private let wxgfStartCode=[UInt8](arrayLiteral:0,0,0,1)
private let wxgfHeaderPrefixLimit=4096
private let wxgfOutputLimit=32*1024*1024
private let wxgfPixelLimit=40_000_000

private func wxgfHeaderRecoveryPayload(_ data:Data) throws -> Data? {
    let bytes=[UInt8](data)
    let starts=try annexBStarts(bytes)
    guard starts.count>=5 else {return nil}
    var sawMalformedHeader=false
    for index in starts.indices {
        let startCodeOffset=starts[index].offset
        if startCodeOffset>wxgfHeaderPrefixLimit {break}
        let unit:AnnexNAL
        do {unit=try annexBNAL(bytes,starts,at:index)}
        catch {sawMalformedHeader=true;continue}
        guard sawMalformedHeader,unit.type==32 else {continue}
        let suffix=Data(data.dropFirst(startCodeOffset))
        guard let units=try? annexBUnits(suffix),hasOrderedHEVCFrameUnits(units) else {continue}
        return suffix
    }
    return nil
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

private func decodeHEVCPixelBuffer(_ units:[AnnexNAL],pixelFormat:OSType) throws -> CVPixelBuffer {
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
        kCVPixelBufferPixelFormatTypeKey:pixelFormat,
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
    return frame
}

private func decodeHEVC(_ units:[AnnexNAL]) throws -> CGImage {
    let frame=try decodeHEVCPixelBuffer(units,pixelFormat:kCVPixelFormatType_32BGRA)
    let width=Int(CVPixelBufferGetWidth(frame)),height=Int(CVPixelBufferGetHeight(frame))
    var cgImage:CGImage?
    guard VTCreateCGImageFromCVPixelBuffer(frame,options:nil,imageOut:&cgImage)==noErr,
          let cgImage,cgImage.width==width,cgImage.height==height else {
        throw Failure("media_image_invalid")
    }
    return cgImage
}

func rgbaPixels(_ image:CGImage) throws -> [UInt8] {
    let width=image.width,height=image.height
    let (pixels,overflow)=width.multipliedReportingOverflow(by:height)
    guard width>0,height>0,!overflow,pixels<=wxgfPixelLimit else {throw Failure("media_resource_limit")}
    let (count,countOverflow)=pixels.multipliedReportingOverflow(by:4)
    guard !countOverflow else {throw Failure("media_resource_limit")}
    var bytes=[UInt8](repeating:0,count:count)
    let drawn=bytes.withUnsafeMutableBytes { raw -> Bool in
        guard let base=raw.baseAddress,
              let context=CGContext(data:base,width:width,height:height,bitsPerComponent:8,bytesPerRow:width*4,
                                    space:CGColorSpaceCreateDeviceRGB(),
                                    bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else {return false}
        context.draw(image,in:CGRect(x:0,y:0,width:width,height:height))
        return true
    }
    guard drawn else {throw Failure("media_image_invalid")}
    return bytes
}

struct LumaPlane {
    let width:Int
    let height:Int
    let values:[UInt8]
}

// 单色帧直接解码为单通道像素，避免经过色彩管理污染透明度数值。
private func decodeHEVCLuma(_ units:[AnnexNAL]) throws -> LumaPlane {
    let frame=try decodeHEVCPixelBuffer(units,pixelFormat:kCVPixelFormatType_OneComponent8)
    guard CVPixelBufferGetPixelFormatType(frame)==kCVPixelFormatType_OneComponent8 else {throw Failure("media_image_invalid")}
    let width=Int(CVPixelBufferGetWidth(frame)),height=Int(CVPixelBufferGetHeight(frame))
    guard width>0,height>0,Int64(width)*Int64(height)<=Int64(wxgfPixelLimit),
          CVPixelBufferLockBaseAddress(frame,.readOnly)==kCVReturnSuccess else {throw Failure("media_image_invalid")}
    defer {CVPixelBufferUnlockBaseAddress(frame,.readOnly)}
    guard let base=CVPixelBufferGetBaseAddress(frame) else {throw Failure("media_image_invalid")}
    let bytesPerRow=CVPixelBufferGetBytesPerRow(frame),source=base.assumingMemoryBound(to:UInt8.self)
    var values=[UInt8](repeating:0,count:width*height)
    for y in 0..<height {for x in 0..<width {values[y*width+x]=source[y*bytesPerRow+x]}}
    return LumaPlane(width:width,height:height,values:values)
}

// 把彩色像素按单色帧亮度预乘，输出带alpha的PNG。
// 不把254放大到255：半透明区域不能被误判为不透明。
func compositeAlpha(_ color:CGImage,_ alpha:LumaPlane) throws -> CGImage {
    guard color.width>0,color.height>0,color.width==alpha.width,color.height==alpha.height,
          alpha.values.count==alpha.width*alpha.height else {
        throw Failure("media_image_invalid")
    }
    let width=color.width,height=color.height
    let colorPixels=try rgbaPixels(color)
    let (count,overflow)=width.multipliedReportingOverflow(by:height*4)
    guard !overflow else {throw Failure("media_resource_limit")}
    var output=[UInt8](repeating:0,count:count)
    for index in stride(from:0,to:count,by:4) {
        let value=alpha.values[index/4]
        let factor=Int(value)
        output[index]=UInt8((Int(colorPixels[index])*factor+127)/255)
        output[index+1]=UInt8((Int(colorPixels[index+1])*factor+127)/255)
        output[index+2]=UInt8((Int(colorPixels[index+2])*factor+127)/255)
        output[index+3]=value
    }
    guard let provider=CGDataProvider(data:Data(output) as CFData),
          let image=CGImage(width:width,height:height,bitsPerComponent:8,bitsPerPixel:32,bytesPerRow:width*4,
                            space:CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo:CGBitmapInfo(rawValue:CGImageAlphaInfo.premultipliedLast.rawValue),
                            provider:provider,decode:nil,shouldInterpolate:false,intent:.defaultIntent) else {
        throw Failure("media_image_invalid")
    }
    return image
}

// 已核验形态为一帧彩色加一帧同尺寸单色透明度；透明度不可用时退回不透明彩色图，不整张丢弃。
private func decodeHEVCDualFrames(_ frames:[[AnnexNAL]]) throws -> Data {
    let classified=try classifyDualHEVCFrames(frames)
    let colorImage=try decodeHEVC(classified.color.units)
    guard let alpha=try? decodeHEVCLuma(classified.alpha.units),
          alpha.width==colorImage.width,alpha.height==colorImage.height else {
        return try png(colorImage)
    }
    guard let composed=try? compositeAlpha(colorImage,alpha),let output=try? png(composed) else {
        return try png(colorImage)
    }
    return output
}

func decodeWxgf(_ data:Data) throws -> Data {
    guard data.count>=4,data.count<=maxBytes,data.prefix(4)==wxgfPrefix else {throw Failure("media_format_unsupported")}
    let payload=data.dropFirst(4)
    let payloadData=Data(payload)
    let jpeg=Data([0xff,0xd8,0xff])
    let pngHeader=Data([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])
    var hevcUnits=try? annexBUnits(payloadData)
    if hevcUnits==nil,let recoveryPayload=try? wxgfHeaderRecoveryPayload(payloadData) {
        hevcUnits=try? annexBUnits(recoveryPayload)
    }
    if let hevcUnits,hevcUnits.contains(where:{$0.type==32}),hevcUnits.contains(where:{$0.type==33}),
       hevcUnits.contains(where:{$0.type==34}),hevcUnits.contains(where:{(0...31).contains($0.type)}) {
        if let frames=try? splitHEVCFrames(hevcUnits) {
            if frames.count==1 {return try png(decodeHEVC(frames[0]))}
            if frames.count==2 {return try decodeHEVCDualFrames(frames)}
            throw Failure("media_format_unsupported")
        }
        return try png(decodeHEVC(hevcUnits))
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
    let units=try hevcUnits ?? annexBUnits(payloadData)
    return try png(decodeHEVC(units))
}
