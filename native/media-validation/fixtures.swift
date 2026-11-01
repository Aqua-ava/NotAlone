// 仅用于生成无私人资料的合成格式夹具，不进入产品运行时。
import Foundation
import ImageIO
import CoreGraphics
import AVFoundation
import CoreMedia

func check(_ condition:Bool) {precondition(condition,"合成夹具生成失败")}
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
    var headerPreamble=Data("wxgf".utf8)
    headerPreamble.append(contentsOf:[0,0,0,1,0x80,0x01])
    for unit in sets+slices {headerPreamble.append(contentsOf:[0,0,0,1]);headerPreamble.append(unit)}
    var headerBeyondBound=Data("wxgf".utf8)
    headerBeyondBound.append(Data(repeating:0xff,count:4097))
    headerBeyondBound.append(contentsOf:[0,0,0,1,0x80,0x01])
    for unit in sets+slices {headerBeyondBound.append(contentsOf:[0,0,0,1]);headerBeyondBound.append(unit)}
    guard output.count>4,output.count<=32*1024*1024,multiple.count<=32*1024*1024,
          headerPreamble.count<=32*1024*1024,headerBeyondBound.count<=32*1024*1024 else {throw FixtureFailure("wxgf_size")}
    try output.write(to:URL(fileURLWithPath:root+"/wxgf"))
    try multiple.write(to:URL(fileURLWithPath:root+"/wxgf.multiframe"))
    try headerPreamble.write(to:URL(fileURLWithPath:root+"/wxgf.header-preamble"))
    try headerBeyondBound.write(to:URL(fileURLWithPath:root+"/wxgf.header-over-limit"))
}
@main struct Fixtures {
    static func main() async throws {
        let root=CommandLine.arguments[1]
        images(root)
        try await video(root+"/h264.mp4",codec:.h264,audio:false)
        try await video(root+"/h264-aac.mp4",codec:.h264,audio:true)
        try await video(root+"/hevc.mp4",codec:.hevc,audio:false)
        try wxgf(root)
    }
}
