// 仅用于生成无私人资料的合成格式夹具，不进入产品运行时。
import Foundation
import ImageIO
import CoreGraphics
import AVFoundation
import CoreMedia

func check(_ condition:Bool) {precondition(condition,"合成夹具生成失败")}
func selfCheck(_ condition:Bool,_ message:String) {
    if !condition {FileHandle.standardError.write(Data(("自测失败："+message+"\n").utf8));exit(1)}
}
private func be16(_ value:Int) -> [UInt8] {[UInt8((value>>8)&0xff),UInt8(value&0xff)]}
private func jpegSegment(_ marker:UInt8,_ payload:[UInt8]) -> [UInt8] {[0xff,marker]+be16(payload.count+2)+payload}
// 渐进式与EXIF内嵌缩略图无法由本机编码器稳定合成，用字节结构直接验证容器检查。
private func syntheticJPEG(scans:Int,embeddedThumbnail:Bool,tail:[UInt8]) -> Data {
    var bytes:[UInt8]=[0xff,0xd8]
    if embeddedThumbnail {
        var payload:[UInt8]=Array("Exif".utf8)+[0,0]
        payload+=[0xff,0xd8,0xff,0xdb,0x00,0x04,0xff,0xd9]
        bytes+=jpegSegment(0xe1,payload)
    }
    bytes+=jpegSegment(0xdb,[0x00]+Array(repeating:1,count:64))
    bytes+=jpegSegment(scans>1 ? 0xc2:0xc0,[8]+be16(1)+be16(1)+[1,1,0x11,0])
    bytes+=jpegSegment(0xc4,[0x00]+Array(repeating:0,count:16))
    for _ in 0..<scans {
        bytes+=jpegSegment(0xda,[1,1,0x00,0,63,0])
        bytes+=[0x12,0xff,0x00,0x34,0xff,0xd0,0x56]
    }
    bytes+=[0xff,0xd9]
    bytes+=tail
    return Data(bytes)
}
func jpegSelfTest() {
    func expectValid(_ data:Data,_ name:String) {
        do {selfCheck(try imageContainer(data,format:"jpeg")==1,name+"应通过")}
        catch let failure as Failure {selfCheck(false,name+"："+failure.code)}
        catch {selfCheck(false,name+"：未知错误")}
    }
    func expectInvalid(_ data:Data,_ name:String) {
        do {_=try imageContainer(data,format:"jpeg");selfCheck(false,name+"应被拒绝")}
        catch let failure as Failure {selfCheck(failure.code=="media_image_invalid",name+"："+failure.code)}
        catch {selfCheck(false,name+"：未知错误")}
    }
    let baseline=syntheticJPEG(scans:1,embeddedThumbnail:false,tail:[])
    expectValid(baseline,"普通JPEG")
    expectValid(syntheticJPEG(scans:2,embeddedThumbnail:false,tail:[]),"渐进式JPEG多扫描")
    expectValid(syntheticJPEG(scans:1,embeddedThumbnail:true,tail:[]),"EXIF内嵌缩略图JPEG")
    expectValid(syntheticJPEG(scans:1,embeddedThumbnail:true,tail:Array(repeating:0x5a,count:24)),"24字节尾随")
    expectValid(syntheticJPEG(scans:2,embeddedThumbnail:false,tail:Array(repeating:0x5a,count:32)),"32字节尾随")
    expectInvalid(syntheticJPEG(scans:1,embeddedThumbnail:false,tail:Array(repeating:0x5a,count:33)),"33字节尾随")
    expectInvalid(syntheticJPEG(scans:1,embeddedThumbnail:false,tail:[0xff,0xd8,0xff,0xd9]),"尾随区内拼接第二张JPEG")
    expectInvalid(Data(baseline.dropLast(2)),"缺少结束标记")
    expectInvalid(Data(baseline.dropLast(1)),"结束标记不完整")
    var embeddedOnly:[UInt8]=[0xff,0xd8]
    embeddedOnly+=jpegSegment(0xe1,Array("Exif".utf8)+[0,0,0xff,0xd8,0xff,0xd9])
    expectInvalid(Data(embeddedOnly),"只有缩略图结束标记")
    expectInvalid(Data([0xff,0xd8,0xd8,0xd9]),"标记位置出现非标记字节")
}
struct FixtureFailure:Error {
    let message:String
    init(_ message:String) {self.message=message}
}
func bitmap() -> CGImage {
    let context=CGContext(data:nil,width:16,height:16,bitsPerComponent:8,bytesPerRow:64,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.setFillColor(CGColor(red:0.2,green:0.5,blue:0.8,alpha:1))
    context.fill(CGRect(x:0,y:0,width:16,height:16))
    return context.makeImage()!
}
func images(_ root:String) {
    for (name,type,count) in [("png","public.png",1),("jpeg","public.jpeg",1),("gif","com.compuserve.gif",2),("many.gif","com.compuserve.gif",121),("bmp","com.microsoft.bmp",1),("tiff","public.tiff",1)] {
        let destination=CGImageDestinationCreateWithURL(URL(fileURLWithPath:root+"/"+name) as CFURL,type as CFString,count,nil)!
        for _ in 0..<count {CGImageDestinationAddImage(destination,bitmap(),[kCGImagePropertyGIFDictionary:[kCGImagePropertyGIFDelayTime:0.1]] as CFDictionary)}
        check(CGImageDestinationFinalize(destination))
    }
}
private struct TestBitWriter {
    var bytes:[UInt8]=[]
    var bitCount=0
    mutating func append(_ value:Int,_ count:Int) {
        for shift in stride(from:count-1,through:0,by:-1) {
            let bit=(value>>shift)&1
            if bitCount%8==0 {bytes.append(0)}
            if bit==1 {bytes[bytes.count-1]|=UInt8(1<<(7-bitCount%8))}
            bitCount+=1
        }
    }
    mutating func ue(_ value:Int) {
        let encoded=value+1,bits=64-encoded.leadingZeroBitCount
        append(0,bits-1)
        append(encoded,bits)
    }
}
private func addEmulationPrevention(_ bytes:[UInt8]) -> [UInt8] {
    var result:[UInt8]=[]
    var zeros=0
    for byte in bytes {
        if zeros==2 && byte<=3 {result.append(3);zeros=0}
        result.append(byte)
        zeros=byte==0 ? zeros+1:0
    }
    return result
}
// 只构造到尺寸字段的SPS；用于纯函数测试，不参与真实解码。
private func syntheticSPS(chroma:Int,width:Int,height:Int) -> Data {
    var writer=TestBitWriter()
    writer.append(0,4)
    writer.append(0,3)
    writer.append(1,1)
    writer.append(0,88)
    writer.append(30,8)
    writer.ue(0)
    writer.ue(chroma)
    if chroma==3 {writer.append(0,1)}
    writer.ue(width)
    writer.ue(height)
    writer.append(0,1)
    writer.append(1,1)
    return Data([0x42,0x01]+addEmulationPrevention(writer.bytes))
}
private func testNAL(_ type:Int,_ sps:Data?=nil) -> AnnexNAL {
    if let sps {return AnnexNAL(type:type,bytes:sps)}
    return AnnexNAL(type:type,bytes:Data([UInt8(type<<1),0x01]))
}
// 真实样本里每帧多带一个SEI；只用于验证分类容忍附加信息单元。
private func seiUnit() -> Data {Data([0x4e,0x01,0x05,0x02,0x00,0x00,0x80])}
private func testFrame(chroma:Int,width:Int=16,height:Int=16) -> [AnnexNAL] {
    [testNAL(32),testNAL(33,syntheticSPS(chroma:chroma,width:width,height:height)),testNAL(34),testNAL(1)]
}
private func testImage(_ pixels:[UInt8],width:Int,height:Int) throws -> CGImage {
    guard let provider=CGDataProvider(data:Data(pixels) as CFData),
          let image=CGImage(width:width,height:height,bitsPerComponent:8,bitsPerPixel:32,bytesPerRow:width*4,
                            space:CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo:CGBitmapInfo(rawValue:CGImageAlphaInfo.premultipliedLast.rawValue),
                            provider:provider,decode:nil,shouldInterpolate:false,intent:.defaultIntent) else {
        throw FixtureFailure("image_create")
    }
    return image
}
func hevcSelfTest() {
    func expectUnsupported(_ frames:[[AnnexNAL]],_ name:String) {
        do {_=try classifyDualHEVCFrames(frames);selfCheck(false,name+"应被拒绝")}
        catch let failure as Failure {selfCheck(failure.code=="media_format_unsupported",name+"："+failure.code)}
        catch {selfCheck(false,name+"：未知错误")}
    }
    let color=testFrame(chroma:1),mono=testFrame(chroma:0),otherSize=testFrame(chroma:0,width:32)
    do {
        let single=try classifyHEVCFrame(color)
        selfCheck(single.sps.chromaFormatIDC==1 && single.sps.width==16 && single.sps.height==16,"彩色帧分类")
        let dual=try classifyDualHEVCFrames([mono,color])
        selfCheck(dual.color.sps.chromaFormatIDC==1 && dual.alpha.sps.chromaFormatIDC==0,"单色在前时分出彩色与透明度帧")
        let reversed=try classifyDualHEVCFrames([color,mono])
        selfCheck(reversed.alpha.sps.chromaFormatIDC==0 && reversed.color.sps.chromaFormatIDC==1,"彩色在前时同样分类")
    } catch let failure as Failure {selfCheck(false,"双帧分类抛出："+failure.code)}
    catch {selfCheck(false,"双帧分类未知错误")}
    expectUnsupported([color,color],"两帧都是彩色")
    expectUnsupported([mono,mono],"两帧都是单色")
    expectUnsupported([mono,otherSize],"尺寸不一致")
    expectUnsupported([mono,color,mono],"三帧")
    let sei=AnnexNAL(type:39,bytes:Data([0x4e,0x01,0x80]))
    do {
        let tolerated=try classifyHEVCFrame([sei]+color+[sei])
        selfCheck(tolerated.sps.chromaFormatIDC==1,"SEI不影响彩色帧分类")
        let leading=try splitHEVCFrames([sei]+mono+[sei]+color)
        selfCheck(leading.count==2 && leading[0].first?.type==39,"首VPS前的SEI并入第一帧")
        selfCheck(try classifyHEVCFrame(leading[0]).sps.chromaFormatIDC==0,"带SEI的单色帧仍可分类")
        do {
            _=try classifyHEVCFrame(color+[testNAL(41)])
            selfCheck(false,"未知NCL单元应被拒绝")
        } catch let failure as Failure {selfCheck(failure.code=="media_format_unsupported","未知单元："+failure.code)}
    } catch let failure as Failure {selfCheck(false,"SEI容忍："+failure.code)}
    catch {selfCheck(false,"SEI容忍未知错误")}
    do {
        let composed=try compositeAlpha(try testImage([10,20,30,255,40,50,60,255,70,80,90,255,100,110,120,255],width:2,height:2),
                                        LumaPlane(width:2,height:2,values:[0,128,255,254]))
        selfCheck(try rgbaPixels(composed)==[0,0,0,0,20,25,30,128,70,80,90,255,100,110,120,254],"透明度合成预乘结果")
    } catch let failure as Failure {selfCheck(false,"透明度合成："+failure.code)}
    catch {selfCheck(false,"透明度合成未知错误")}
    do {
        let frames=try splitHEVCFrames(mono+color)
        selfCheck(frames.count==2 && frames[0].count==4 && frames[1].count==4,"按VPS切分双帧")
        selfCheck(try splitHEVCFrames(color).count==1,"单帧保持一帧")
        do {
            _=try splitHEVCFrames([testNAL(33),testNAL(1)])
            selfCheck(false,"首单元不是VPS应被拒绝")
        } catch let failure as Failure {selfCheck(failure.code=="media_image_invalid","首单元不是VPS："+failure.code)}
        var stream=Data()
        for unit in mono+color {stream.append(contentsOf:[0,0,0,1]);stream.append(unit.bytes)}
        selfCheck(try splitHEVCFrames(annexBUnits(stream)).count==2,"Annex B解析后仍按VPS切分")
    } catch let failure as Failure {selfCheck(false,"分组："+failure.code)}
    catch {selfCheck(false,"分组未知错误")}
    for chroma in 0...3 {
        guard let sps=hevcSPSInfo(syntheticSPS(chroma:chroma,width:320,height:240)) else {
            selfCheck(false,"SPS chroma="+String(chroma)+"解析失败");continue
        }
        selfCheck(sps.chromaFormatIDC==chroma && sps.width==320 && sps.height==240,"SPS chroma="+String(chroma))
    }
    selfCheck(hevcSPSInfo(Data(syntheticSPS(chroma:1,width:16,height:16).prefix(16)))==nil,"截短SPS应返回nil")
    selfCheck(hevcSPSInfo(Data([0x42,0x01,0x00]))==nil,"极短SPS应返回nil")
}

func audioSample() -> CMSampleBuffer {
    var stream=AudioStreamBasicDescription(mSampleRate:48_000,mFormatID:kAudioFormatLinearPCM,mFormatFlags:kAudioFormatFlagIsSignedInteger|kAudioFormatFlagIsPacked,mBytesPerPacket:2,mFramesPerPacket:1,mBytesPerFrame:2,mChannelsPerFrame:1,mBitsPerChannel:16,mReserved:0)
    var description:CMAudioFormatDescription?
    check(CMAudioFormatDescriptionCreate(allocator:kCFAllocatorDefault,asbd:&stream,layoutSize:0,layout:nil,magicCookieSize:0,magicCookie:nil,extensions:nil,formatDescriptionOut:&description)==noErr)
    var block:CMBlockBuffer?
    check(CMBlockBufferCreateWithMemoryBlock(allocator:kCFAllocatorDefault,memoryBlock:nil,blockLength:192_000,blockAllocator:kCFAllocatorDefault,customBlockSource:nil,offsetToData:0,dataLength:192_000,flags:0,blockBufferOut:&block)==noErr)
    check(CMBlockBufferFillDataBytes(with:0,blockBuffer:block!,offsetIntoDestination:0,dataLength:192_000)==noErr)
    var sample:CMSampleBuffer?
    check(CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator:kCFAllocatorDefault,dataBuffer:block!,formatDescription:description!,sampleCount:96_000,presentationTimeStamp:.zero,packetDescriptions:nil,sampleBufferOut:&sample)==noErr)
    return sample!
}
func video(_ path:String,codec:AVVideoCodecType,audio:Bool,frameCount:Int=2) async throws {
    let writer=try AVAssetWriter(url:URL(fileURLWithPath:path),fileType:.mp4)
    let input=AVAssetWriterInput(mediaType:.video,outputSettings:[AVVideoCodecKey:codec,AVVideoWidthKey:16,AVVideoHeightKey:16])
    writer.add(input)
    let adaptor=AVAssetWriterInputPixelBufferAdaptor(assetWriterInput:input,sourcePixelBufferAttributes:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32ARGB,kCVPixelBufferWidthKey as String:16,kCVPixelBufferHeightKey as String:16])
    let sound=audio ? AVAssetWriterInput(mediaType:.audio,outputSettings:[AVFormatIDKey:kAudioFormatMPEG4AAC,AVSampleRateKey:48_000,AVNumberOfChannelsKey:1,AVEncoderBitRateKey:64_000]):nil
    if let sound {writer.add(sound)}
    check(writer.startWriting());writer.startSession(atSourceTime:.zero)
    var pixel:CVPixelBuffer?
    check(CVPixelBufferCreate(kCFAllocatorDefault,16,16,kCVPixelFormatType_32ARGB,nil,&pixel)==kCVReturnSuccess)
    CVPixelBufferLockBaseAddress(pixel!,[])
    memset(CVPixelBufferGetBaseAddress(pixel!),60,CVPixelBufferGetDataSize(pixel!))
    CVPixelBufferUnlockBaseAddress(pixel!,[])
    for index in 0..<frameCount {
        check(adaptor.append(pixel!,withPresentationTime:CMTime(value:Int64(index),timescale:1)))
    }
    input.markAsFinished()
    if let sound {check(sound.append(audioSample()));sound.markAsFinished()}
    writer.endSession(atSourceTime:CMTime(value:Int64(frameCount),timescale:1))
    await writer.finishWriting()
    check(writer.status == .completed)
}
private final class EncodedFrame: @unchecked Sendable {
    private let lock=NSLock()
    private var value:CMSampleBuffer?
    private var result=OSStatus(noErr)
    func receive(_ sample:CMSampleBuffer?,status:OSStatus) {lock.lock();defer {lock.unlock()};result=status;value=sample}
    func get() -> (CMSampleBuffer?,OSStatus) {lock.lock();defer {lock.unlock()};return (value,result)}
}
private let captureHevcFrame:VTCompressionOutputCallback={context,_,status,_,sample in
    guard let context else {return}
    Unmanaged<EncodedFrame>.fromOpaque(context).takeUnretainedValue().receive(sample,status:status)
}
// 必须显式指定单色profile：默认HEVC Main即使输入单通道也会编码成4:2:0，SPS chroma_format_idc不会是0。
func monoHEVC(_ alpha:[UInt8]) throws -> (annexB:Data,sets:[Data],slices:[Data]) {
    let width=16,height=16
    guard alpha.count==width*height else {throw FixtureFailure("mono_alpha_size")}
    let attributes:[CFString:Any]=[kCVPixelBufferPixelFormatTypeKey:kCVPixelFormatType_OneComponent8,
        kCVPixelBufferWidthKey:width,kCVPixelBufferHeightKey:height,kCVPixelBufferIOSurfacePropertiesKey:[:]]
    var pixel:CVPixelBuffer?
    guard CVPixelBufferCreate(kCFAllocatorDefault,width,height,kCVPixelFormatType_OneComponent8,attributes as CFDictionary,&pixel)==kCVReturnSuccess,
          let pixel else {throw FixtureFailure("mono_pixel")}
    CVPixelBufferLockBaseAddress(pixel,[])
    guard let base=CVPixelBufferGetBaseAddress(pixel)?.assumingMemoryBound(to:UInt8.self) else {
        CVPixelBufferUnlockBaseAddress(pixel,[]);throw FixtureFailure("mono_base")
    }
    let rowBytes=CVPixelBufferGetBytesPerRow(pixel)
    for y in 0..<height {for x in 0..<width {base[y*rowBytes+x]=alpha[y*width+x]}}
    CVPixelBufferUnlockBaseAddress(pixel,[])

    let encoded=EncodedFrame()
    var session:VTCompressionSession?
    guard VTCompressionSessionCreate(allocator:kCFAllocatorDefault,width:Int32(width),height:Int32(height),codecType:kCMVideoCodecType_HEVC,encoderSpecification:nil,imageBufferAttributes:attributes as CFDictionary,compressedDataAllocator:nil,outputCallback:captureHevcFrame,refcon:Unmanaged.passUnretained(encoded).toOpaque(),compressionSessionOut:&session)==noErr,
          let session else {throw FixtureFailure("mono_encoder")}
    defer {VTCompressionSessionInvalidate(session)}
    guard VTSessionSetProperty(session,key:kVTCompressionPropertyKey_ProfileLevel,value:kVTProfileLevel_HEVC_Monochrome_AutoLevel)==noErr,
          VTSessionSetProperty(session,key:kVTCompressionPropertyKey_MaxKeyFrameInterval,value:1 as CFNumber)==noErr,
          VTCompressionSessionPrepareToEncodeFrames(session)==noErr else {throw FixtureFailure("mono_setup")}
    var encodeFlags=VTEncodeInfoFlags()
    guard VTCompressionSessionEncodeFrame(session,imageBuffer:pixel,presentationTimeStamp:.zero,duration:CMTime(value:1,timescale:30),frameProperties:nil,sourceFrameRefcon:nil,infoFlagsOut:&encodeFlags)==noErr,
          VTCompressionSessionCompleteFrames(session,untilPresentationTimeStamp:.invalid)==noErr else {throw FixtureFailure("mono_encode")}
    let (sample,status)=encoded.get()
    guard status==noErr,let sample,let description=CMSampleBufferGetFormatDescription(sample),
          let block=CMSampleBufferGetDataBuffer(sample) else {throw FixtureFailure("mono_sample")}
    var setCount=0
    guard CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(description,parameterSetIndex:0,parameterSetPointerOut:nil,parameterSetSizeOut:nil,parameterSetCountOut:&setCount,nalUnitHeaderLengthOut:nil)==noErr,
          setCount>=3,setCount<=16 else {throw FixtureFailure("mono_parameter_set_count")}
    var sets:[Data]=[]
    for index in 0..<setCount {
        var pointer:UnsafePointer<UInt8>?
        var size=0
        guard CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(description,parameterSetIndex:index,parameterSetPointerOut:&pointer,parameterSetSizeOut:&size,parameterSetCountOut:nil,nalUnitHeaderLengthOut:nil)==noErr,
              let pointer,size>2,size<=1_000_000 else {throw FixtureFailure("mono_parameter_set_fetch")}
        let unit=Data(bytes:pointer,count:size)
        if (32...34).contains((Int(unit[0])>>1)&0x3f) {sets.append(unit)}
    }
    let length=CMBlockBufferGetDataLength(block)
    guard length>0,length<=32*1024*1024 else {throw FixtureFailure("mono_sample_size")}
    var bytes=Data(count:length)
    let copy=bytes.withUnsafeMutableBytes { raw -> OSStatus in
        guard let base=raw.baseAddress else {return OSStatus(paramErr)}
        return CMBlockBufferCopyDataBytes(block,atOffset:0,dataLength:length,destination:base.assumingMemoryBound(to:Int8.self))
    }
    guard copy==kCMBlockBufferNoErr else {throw FixtureFailure("mono_sample_copy")}
    var slices:[Data]=[]
    var cursor=0
    while cursor<bytes.count {
        guard bytes.count-cursor>=4 else {throw FixtureFailure("mono_nal_length")}
        let count=(Int(bytes[cursor])<<24)|(Int(bytes[cursor+1])<<16)|(Int(bytes[cursor+2])<<8)|Int(bytes[cursor+3])
        cursor+=4
        guard count>2,count<=bytes.count-cursor else {throw FixtureFailure("mono_nal_size")}
        let unit=Data(bytes[cursor..<cursor+count])
        if (Int(unit[0])>>1)&0x3f < 32 {slices.append(unit)}
        cursor+=count
    }
    guard sets.count>=3,!slices.isEmpty else {throw FixtureFailure("mono_units")}
    var annexB=Data()
    for unit in sets+slices {annexB.append(contentsOf:[0,0,0,1]);annexB.append(unit)}
    return (annexB,sets,slices)
}
func wxgf(_ root:String) throws {
    let attributes:[CFString:Any]=[kCVPixelBufferPixelFormatTypeKey:kCVPixelFormatType_32ARGB,kCVPixelBufferWidthKey:16,kCVPixelBufferHeightKey:16,kCVPixelBufferIOSurfacePropertiesKey:[:]]
    var pixel:CVPixelBuffer?
    guard CVPixelBufferCreate(kCFAllocatorDefault,16,16,kCVPixelFormatType_32ARGB,attributes as CFDictionary,&pixel)==kCVReturnSuccess,
          let pixel else {throw FixtureFailure("pixel_create")}
    CVPixelBufferLockBaseAddress(pixel,[])
    guard let base=CVPixelBufferGetBaseAddress(pixel),
          let context=CGContext(data:base,width:16,height:16,bitsPerComponent:8,bytesPerRow:CVPixelBufferGetBytesPerRow(pixel),space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.noneSkipFirst.rawValue) else {
        CVPixelBufferUnlockBaseAddress(pixel,[]);throw FixtureFailure("pixel_draw")
    }
    context.setFillColor(CGColor(red:0.2,green:0.5,blue:0.8,alpha:1));context.fill(CGRect(x:0,y:0,width:16,height:16))
    CVPixelBufferUnlockBaseAddress(pixel,[])

    let encoded=EncodedFrame()
    var session:VTCompressionSession?
    let create=VTCompressionSessionCreate(allocator:kCFAllocatorDefault,width:16,height:16,codecType:kCMVideoCodecType_HEVC,encoderSpecification:nil,imageBufferAttributes:attributes as CFDictionary,compressedDataAllocator:nil,outputCallback:captureHevcFrame,refcon:Unmanaged.passUnretained(encoded).toOpaque(),compressionSessionOut:&session)
    guard create==noErr,let session else {throw FixtureFailure("encoder_unavailable")}
    defer {VTCompressionSessionInvalidate(session)}
    guard VTSessionSetProperty(session,key:kVTCompressionPropertyKey_RealTime,value:kCFBooleanTrue)==noErr,
          VTSessionSetProperty(session,key:kVTCompressionPropertyKey_MaxKeyFrameInterval,value:1 as CFNumber)==noErr,
          VTCompressionSessionPrepareToEncodeFrames(session)==noErr else {throw FixtureFailure("encoder_setup")}
    var encodeFlags=VTEncodeInfoFlags()
    guard VTCompressionSessionEncodeFrame(session,imageBuffer:pixel,presentationTimeStamp:.zero,duration:CMTime(value:1,timescale:30),frameProperties:nil,sourceFrameRefcon:nil,infoFlagsOut:&encodeFlags)==noErr,
          VTCompressionSessionCompleteFrames(session,untilPresentationTimeStamp:.invalid)==noErr else {throw FixtureFailure("encode")}
    let (sample,status)=encoded.get()
    guard status==noErr,let sample,let description=CMSampleBufferGetFormatDescription(sample),
          let block=CMSampleBufferGetDataBuffer(sample) else {throw FixtureFailure("encoded_sample")}
    let length=CMBlockBufferGetDataLength(block)
    guard length>0,length<=32*1024*1024 else {throw FixtureFailure("encoded_sample_size")}
    var bytes=Data(count:length)
    let copy=bytes.withUnsafeMutableBytes { raw -> OSStatus in
        guard let base=raw.baseAddress else {return OSStatus(paramErr)}
        return CMBlockBufferCopyDataBytes(block,atOffset:0,dataLength:length,destination:base.assumingMemoryBound(to:Int8.self))
    }
    guard copy==kCMBlockBufferNoErr else {throw FixtureFailure("encoded_sample_copy")}
    var setCount=0
    guard CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(description,parameterSetIndex:0,parameterSetPointerOut:nil,parameterSetSizeOut:nil,parameterSetCountOut:&setCount,nalUnitHeaderLengthOut:nil)==noErr,
          setCount>=3,setCount<=16 else {throw FixtureFailure("parameter_set_count")}
    var sets:[Data]=[]
    for index in 0..<setCount {
        var pointer:UnsafePointer<UInt8>?
        var size=0
        guard CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(description,parameterSetIndex:index,parameterSetPointerOut:&pointer,parameterSetSizeOut:&size,parameterSetCountOut:nil,nalUnitHeaderLengthOut:nil)==noErr,
              let pointer,size>2,size<=1_000_000 else {throw FixtureFailure("parameter_set_fetch")}
        let unit=Data(bytes:pointer,count:size)
        if (32...34).contains((Int(unit[0])>>1)&0x3f) {sets.append(unit)}
    }
    var slices:[Data]=[]
    var cursor=0
    while cursor<bytes.count {
        guard bytes.count-cursor>=4 else {throw FixtureFailure("nal_length_prefix")}
        let count=(Int(bytes[cursor])<<24)|(Int(bytes[cursor+1])<<16)|(Int(bytes[cursor+2])<<8)|Int(bytes[cursor+3])
        cursor+=4
        guard count>2,count<=bytes.count-cursor else {throw FixtureFailure("nal_size")}
        let unit=Data(bytes[cursor..<cursor+count])
        let type=(Int(unit[0])>>1)&0x3f
        if (0...31).contains(type) {slices.append(unit)}
        cursor+=count
    }
    guard sets.count>=3,!slices.isEmpty else {throw FixtureFailure("wxgf_units")}
    func stream(repeats:Int) -> Data {
        var result=Data("wxgf".utf8)
        for unit in sets+slices.flatMap{Array(repeating:$0,count:repeats)} {result.append(contentsOf:[0,0,0,1]);result.append(unit)}
        return result
    }
    let output=stream(repeats:1),multiple=stream(repeats:2)
    let alphaValues=(0..<256).map{UInt8((($0%16)*255)/15)}
    let mono=try monoHEVC(alphaValues)
    let alphaFrame=mono.annexB
    func frameData(_ sets:[Data],_ slices:[Data]) -> Data {
        var result=Data()
        for unit in sets+slices {result.append(contentsOf:[0,0,0,1]);result.append(unit)}
        return result
    }
    let colorFrame=frameData(sets,slices)
    let brokenAlphaFrame=frameData(mono.sets,mono.slices.map{Data($0.prefix(2))})
    var dualFrame=Data("wxgf".utf8);dualFrame.append(alphaFrame);dualFrame.append(colorFrame)
    var dualBrokenAlpha=Data("wxgf".utf8);dualBrokenAlpha.append(brokenAlphaFrame);dualBrokenAlpha.append(colorFrame)
    var dualTwoColor=Data("wxgf".utf8);dualTwoColor.append(colorFrame);dualTwoColor.append(colorFrame)
    let sei=seiUnit()
    var dualSei=Data("wxgf".utf8)
    dualSei.append(frameData(mono.sets+[sei],mono.slices));dualSei.append(frameData(sets+[sei],slices))
    var dualSeiLeading=Data("wxgf".utf8)
    dualSeiLeading.append(contentsOf:[0,0,0,1]);dualSeiLeading.append(sei)
    dualSeiLeading.append(alphaFrame);dualSeiLeading.append(colorFrame)
    var singleSei=Data("wxgf".utf8);singleSei.append(frameData(sets+[sei],slices))
    var headerPreamble=Data("wxgf".utf8)
    headerPreamble.append(contentsOf:[0,0,0,1,0x80,0x01])
    for unit in sets+slices {headerPreamble.append(contentsOf:[0,0,0,1]);headerPreamble.append(unit)}
    // 真实 wxgf 头约 4.1KB 且含伪起始码；这些形态必须仍能解码，超过 16KiB 的头才拒绝。
    func realShaped(header:Int,fakeSps:Bool,fakeVps:Bool=false,tail:[UInt8]?,tailSlice:Bool=false) -> Data {
        var result=Data("wxgf".utf8)
        result.append(Data(repeating:0xff,count:header))
        result.append(contentsOf:[0,0,0,1,0x80,0x01])
        if fakeSps {result.append(contentsOf:[0,0,0,1,0x42,0x01,0xaa,0xbb,0xcc])}
        // 真实样本里头尾都有“头字节合法但 nuh_layer_id 非零”的伪 VPS/SPS。
        if fakeVps {result.append(contentsOf:[0,0,0,1,0x40,0x35,0x01,0x02])}
        for unit in sets+slices {result.append(contentsOf:[0,0,0,1]);result.append(unit)}
        if let tail {
            result.append(contentsOf:[0,0,0,1]);result.append(contentsOf:tail)
            if tailSlice,let slice=slices.first {result.append(contentsOf:[0,0,0,1]);result.append(slice)}
        }
        return result
    }
    let headerLong=realShaped(header:4200,fakeSps:false,tail:nil)
    let leadingFakeSps=realShaped(header:0,fakeSps:true,tail:nil)
    let trailingGarbage=realShaped(header:0,fakeSps:false,tail:[0xf6,0xdb,0x01,0x02])
    let realShape=realShaped(header:4200,fakeSps:true,tail:[0xf6,0xdb,0x01,0x02])
    let fakeVpsBefore=realShaped(header:28,fakeSps:false,fakeVps:true,tail:nil)
    let trailingFakeSps=realShaped(header:0,fakeSps:false,tail:[0x43,0x66,0x11,0x22])
    let garbageThenSlice=realShaped(header:0,fakeSps:false,tail:[0xf6,0xdb,0x01,0x02],tailSlice:true)
    var headerBeyondBound=Data("wxgf".utf8)
    headerBeyondBound.append(Data(repeating:0xff,count:16*1024+1))
    headerBeyondBound.append(contentsOf:[0,0,0,1,0x80,0x01])
    for unit in sets+slices {headerBeyondBound.append(contentsOf:[0,0,0,1]);headerBeyondBound.append(unit)}
    guard output.count>4,output.count<=32*1024*1024,multiple.count<=32*1024*1024,
          headerPreamble.count<=32*1024*1024,headerBeyondBound.count<=32*1024*1024,
          dualFrame.count<=32*1024*1024,dualBrokenAlpha.count<=32*1024*1024,dualTwoColor.count<=32*1024*1024,
          dualSei.count<=32*1024*1024,dualSeiLeading.count<=32*1024*1024,singleSei.count<=32*1024*1024 else {throw FixtureFailure("wxgf_size")}
    try output.write(to:URL(fileURLWithPath:root+"/wxgf"))
    try multiple.write(to:URL(fileURLWithPath:root+"/wxgf.multiframe"))
    try headerPreamble.write(to:URL(fileURLWithPath:root+"/wxgf.header-preamble"))
    try headerBeyondBound.write(to:URL(fileURLWithPath:root+"/wxgf.header-over-limit"))
    for (name,data) in [("header-long",headerLong),("leading-fake-sps",leadingFakeSps),("trailing-garbage",trailingGarbage),
                        ("real-shape",realShape),("fake-vps-before",fakeVpsBefore),("trailing-fake-sps",trailingFakeSps),
                        ("garbage-then-slice",garbageThenSlice)] {
        guard data.count<=32*1024*1024 else {throw FixtureFailure("wxgf_size")}
        try data.write(to:URL(fileURLWithPath:root+"/wxgf."+name))
    }
    try dualFrame.write(to:URL(fileURLWithPath:root+"/wxgf.dual-frame"))
    try dualBrokenAlpha.write(to:URL(fileURLWithPath:root+"/wxgf.dual-frame-broken-alpha"))
    try dualTwoColor.write(to:URL(fileURLWithPath:root+"/wxgf.dual-frame-two-color"))
    try dualSei.write(to:URL(fileURLWithPath:root+"/wxgf.dual-frame-sei"))
    try dualSeiLeading.write(to:URL(fileURLWithPath:root+"/wxgf.dual-frame-sei-leading"))
    try singleSei.write(to:URL(fileURLWithPath:root+"/wxgf.sei"))
    try verifyWxgfFixtures(root)
}
// 夹具生成后立即走一遍真实解码，验证透明度合成与降级，而不是只依赖文件存在。
private func verifyWxgfFixtures(_ root:String) throws {
    func decode(_ name:String) throws -> Data {try decodeWxgf(try Data(contentsOf:URL(fileURLWithPath:root+"/"+name)))}
    let plain=try decode("wxgf")
    let dual=try decode("wxgf.dual-frame")
    guard dual.count>26,dual[25]==6 else {throw FixtureFailure("dual_alpha_png")}
    guard let source=CGImageSourceCreateWithData(dual as CFData,nil),
          let image=CGImageSourceCreateImageAtIndex(source,0,nil) else {throw FixtureFailure("dual_png_decode")}
    guard image.width==16,image.height==16 else {throw FixtureFailure("dual_png_size")}
    let pixels=try rgbaPixels(image)
    for x in 0..<16 {
        // HEVC有损压缩会让单色帧亮度有少量偏差，允许±6。
        let expected=Int((x*255)/15),actual=Int(pixels[x*4+3])
        guard abs(actual-expected)<=6 else {throw FixtureFailure("dual_alpha_value")}
    }
    guard try decode("wxgf.dual-frame-broken-alpha")==plain else {throw FixtureFailure("broken_alpha_fallback")}
    for name in ["wxgf.dual-frame-sei","wxgf.dual-frame-sei-leading"] {
        guard try decode(name)==dual else {throw FixtureFailure("dual_sei_output")}
    }
    guard try decode("wxgf.sei")==plain else {throw FixtureFailure("single_sei_output")}
    for name in ["wxgf.header-long","wxgf.leading-fake-sps","wxgf.trailing-garbage","wxgf.real-shape","wxgf.fake-vps-before","wxgf.trailing-fake-sps"] {
        guard try decode(name)==plain else {throw FixtureFailure("real_shape_output")}
    }
    do {
        _=try decode("wxgf.garbage-then-slice")
        throw FixtureFailure("garbage_then_slice_accepted")
    } catch let failure as Failure {
        guard failure.code=="media_image_invalid" else {throw FixtureFailure("garbage_then_slice_error")}
    }
    do {
        _=try decode("wxgf.dual-frame-two-color")
        throw FixtureFailure("two_color_accepted")
    } catch let failure as Failure {
        guard failure.code=="media_format_unsupported" else {throw FixtureFailure("two_color_error")}
    }
}
@main struct Fixtures {
    static func main() async throws {
        let root=CommandLine.arguments[1]
        if root=="--selftest" {jpegSelfTest();hevcSelfTest();print("selftest ok");return}
        images(root)
        try await video(root+"/h264.mp4",codec:.h264,audio:false)
        try await video(root+"/h264-aac.mp4",codec:.h264,audio:true)
        try await video(root+"/hevc.mp4",codec:.hevc,audio:false)
        try wxgf(root)
    }
}
