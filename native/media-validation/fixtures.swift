// 仅用于生成无私人资料的合成格式夹具，不进入产品运行时。
import Foundation
import ImageIO
import CoreGraphics
import AVFoundation
import CoreMedia

func check(_ condition:Bool) {precondition(condition,"合成夹具生成失败")}
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
func video(_ path:String,codec:AVVideoCodecType,audio:Bool) async throws {
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
    check(adaptor.append(pixel!,withPresentationTime:.zero))
    check(adaptor.append(pixel!,withPresentationTime:CMTime(value:1,timescale:1)))
    input.markAsFinished()
    if let sound {check(sound.append(audioSample()));sound.markAsFinished()}
    writer.endSession(atSourceTime:CMTime(value:2,timescale:1))
    await writer.finishWriting()
    check(writer.status == .completed)
}
@main struct Fixtures {
    static func main() async throws {
        let root=CommandLine.arguments[1]
        images(root)
        try await video(root+"/h264.mp4",codec:.h264,audio:false)
        try await video(root+"/h264-aac.mp4",codec:.h264,audio:true)
        try await video(root+"/hevc.mp4",codec:.hevc,audio:false)
    }
}
