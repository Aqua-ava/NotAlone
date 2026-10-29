import Foundation
import ImageIO
import CoreGraphics
import AVFoundation
import CoreMedia
import Darwin

struct Failure: Error { let code: String; init(_ code: String) {self.code=code} }
func emit(_ object: [String:Any], status: Int32=0) -> Never {
    if let data=try? JSONSerialization.data(withJSONObject:object,options:[.sortedKeys]) {FileHandle.standardOutput.write(data)}
    exit(status)
}
let maxBytes=32*1024*1024
func inputData() throws -> Data {
    var info=stat()
    guard fstat(3,&info)==0, (info.st_mode&S_IFMT)==S_IFREG, info.st_nlink==1, info.st_size>0 else {throw Failure("media_image_invalid")}
    guard info.st_size<=maxBytes else {throw Failure("media_resource_too_large")}
    let file=FileHandle(fileDescriptor:3,closeOnDealloc:false)
    var data=Data()
    while let chunk=try file.read(upToCount:64*1024),!chunk.isEmpty {
        guard data.count<=maxBytes-chunk.count else {throw Failure("media_resource_too_large")}
        data.append(chunk)
    }
    guard data.count==info.st_size else {throw Failure("media_image_invalid")}
    return data
}
func image(_ data:Data) throws -> [String:Any] {
    let options=[kCGImageSourceShouldCache:false] as CFDictionary
    guard let source=CGImageSourceCreateWithData(data as CFData,options),let type=CGImageSourceGetType(source) as String? else {throw Failure("media_format_unsupported")}
    let formats=["public.png":["png","image/png"],"public.jpeg":["jpeg","image/jpeg"],"com.compuserve.gif":["gif","image/gif"],"com.microsoft.bmp":["bmp","image/bmp"]]
    guard let format=formats[type] else {throw Failure("media_format_unsupported")}
    let declaredFrames=try imageContainer(data,format:format[0])
    let count=CGImageSourceGetCount(source)
    guard declaredFrames==count else {throw Failure("media_image_invalid")}
    guard count>0,count<=120 else {throw Failure("media_resource_limit")}
    guard CGImageSourceGetStatus(source) == .statusComplete else {throw Failure("media_image_invalid")}
    var totalPixels=0
    for index in 0..<count {
        try autoreleasepool {
            guard let properties=CGImageSourceCopyPropertiesAtIndex(source,index,nil) as? [String:Any],
                let width=properties[kCGImagePropertyPixelWidth as String] as? Int,
                let height=properties[kCGImagePropertyPixelHeight as String] as? Int,
                width>0,height>0,width<=40_000_000,height<=40_000_000 else {throw Failure("media_image_invalid")}
            let (pixels,overflow)=width.multipliedReportingOverflow(by:height)
            guard !overflow,pixels<=40_000_000,totalPixels<=80_000_000-pixels else {throw Failure("media_resource_limit")}
            totalPixels+=pixels
            guard let decoded=CGImageSourceCreateImageAtIndex(source,index,[kCGImageSourceShouldCacheImmediately:true] as CFDictionary),decoded.width==width,decoded.height==height,
                  let bitmap=CGContext(data:nil,width:width,height:height,bitsPerComponent:8,bytesPerRow:width*4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else {throw Failure("media_image_invalid")}
            bitmap.draw(decoded,in:CGRect(x:0,y:0,width:width,height:height))
            guard CGImageSourceGetStatusAtIndex(source,index) == .statusComplete else {throw Failure("media_image_invalid")}
        }
    }
    return ["format":format[0],"mimeType":format[1],"containerValid":true,"viewable":true,"playable":false,"frames":count]
}
func mp4(_ data:Data) throws -> Int {
    func u32(_ offset:Int)->UInt64 {data[offset..<offset+4].reduce(0){($0<<8)|UInt64($1)}}
    var ftyp=false;var moov=false;var mdat=false;var references=0;var boxes=0
    func atoms(_ start:Int,_ end:Int,_ root:Bool,_ depth:Int=0) throws {
        guard depth<=6 else {throw Failure("media_resource_limit")}
        var cursor=start
        while cursor<end {
            boxes+=1;guard boxes<=10_000 else {throw Failure("media_resource_limit")}
            guard end-cursor>=8 else {throw Failure("media_video_invalid")}
            var length=u32(cursor);var header=8
            let atom=String(data:data[cursor+4..<cursor+8],encoding:.ascii) ?? ""
            if length==1 {guard end-cursor>=16 else {throw Failure("media_video_invalid")};length=(u32(cursor+8)<<32)|u32(cursor+12);header=16}
            if length==0 {guard root,atom=="mdat" else {throw Failure("media_video_invalid")};length=UInt64(end-cursor)}
            guard length>=UInt64(header),length<=UInt64(end-cursor) else {throw Failure("media_video_invalid")}
            let next=cursor+Int(length)
            if root {
                guard ["ftyp","moov","mdat","free","skip","wide"].contains(atom) else {throw Failure("media_format_unsupported")}
                if atom=="ftyp" {
                    guard !ftyp,length>=16 else {throw Failure("media_video_invalid")};ftyp=true
                    let brand=String(data:data[cursor+header..<cursor+header+4],encoding:.ascii) ?? ""
                    guard ["isom","iso2","mp41","mp42","avc1","M4V "].contains(brand) else {throw Failure("media_format_unsupported")}
                }
                if atom=="moov" {guard !moov else {throw Failure("media_video_invalid")};moov=true}
                if atom=="mdat" {mdat=true}
            }
            // 不允许引用其他文件或URL的QuickTime引用电影及外部data-reference。
            if ["rmra","rmda","rdrf"].contains(atom) {throw Failure("media_format_unsupported")}
            if ["moov","trak","mdia","minf","dinf"].contains(atom) {try atoms(cursor+header,next,false,depth+1)}
            if atom=="dref" {
                let body=cursor+header
                guard next-body==20,u32(body)==0,u32(body+4)==1,u32(body+8)==12,
                      String(data:data[body+12..<body+16],encoding:.ascii)=="url ",u32(body+16)==1 else {throw Failure("media_format_unsupported")}
                references+=1
            }
            cursor=next
        }
    }
    try atoms(0,data.count,true)
    guard ftyp,moov,mdat,references>=1,references<=2 else {throw Failure("media_format_unsupported")}
    return references
}
final class MemoryLoader: NSObject, AVAssetResourceLoaderDelegate, @unchecked Sendable {
    let data:Data
    init(_ data:Data) {self.data=data}
    func resourceLoader(_ resourceLoader:AVAssetResourceLoader,shouldWaitForLoadingOfRequestedResource request:AVAssetResourceLoadingRequest)->Bool {
        guard request.request.url?.absoluteString=="notalone-media://single/resource.mp4" else {request.finishLoading(with:Failure("media_format_unsupported"));return true}
        if let info=request.contentInformationRequest {
            info.contentType=AVFileType.mp4.rawValue
            info.contentLength=Int64(data.count)
            info.isByteRangeAccessSupported=true
        }
        if let reading=request.dataRequest {
            let offset=max(reading.requestedOffset,reading.currentOffset)
            guard offset>=0,offset<=data.count,reading.requestedLength>=0 else {request.finishLoading(with:Failure("media_video_invalid"));return true}
            let available=data.count-Int(offset)
            let length=reading.requestsAllDataToEndOfResource ? available:min(available,reading.requestedLength)
            reading.respond(with:data[Int(offset)..<Int(offset)+length])
        }
        request.finishLoading()
        return true
    }
}
func video(_ data:Data) async throws -> [String:Any] {
    let references=try mp4(data)
    let loader=MemoryLoader(data)
    let asset=AVURLAsset(url:URL(string:"notalone-media://single/resource.mp4")!,options:[AVURLAssetPreferPreciseDurationAndTimingKey:true])
    asset.resourceLoader.setDelegate(loader,queue:DispatchQueue(label:"notalone.media.validator"))
    defer {withExtendedLifetime(loader) {}}
    let duration=try await asset.load(.duration).seconds
    guard duration.isFinite,duration>0,duration<=120 else {throw Failure("media_resource_limit")}
    guard try await asset.load(.isPlayable),try await !asset.load(.hasProtectedContent) else {throw Failure("media_video_invalid")}
    let tracks=try await asset.load(.tracks)
    guard tracks.count>=1,tracks.count<=2,tracks.count==references else {throw Failure("media_format_unsupported")}
    var videoCount=0;var audioCount=0;var totalFrames=0
    for track in tracks {
        let descriptions=try await track.load(.formatDescriptions)
        guard descriptions.count==1,let description=descriptions.first else {throw Failure("media_format_unsupported")}
        let mediaType=track.mediaType
        let codec=CMFormatDescriptionGetMediaSubType(description)
        let settings:[String:Any]
        var sampleStep=0.0
        if mediaType == .video {
            videoCount+=1
            guard videoCount==1,codec==kCMVideoCodecType_H264 else {throw Failure("media_format_unsupported")}
            let size=CMVideoFormatDescriptionGetDimensions(description)
            guard size.width>0,size.height>0,Int64(size.width)*Int64(size.height)<=40_000_000 else {throw Failure("media_resource_limit")}
            let rate=try await track.load(.nominalFrameRate)
            guard rate.isFinite,rate>0,rate<=60 else {throw Failure("media_resource_limit")}
            sampleStep=1.0/Double(rate)
            settings=[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA]
        } else if mediaType == .audio {
            audioCount+=1
            guard audioCount==1,codec==kAudioFormatMPEG4AAC else {throw Failure("media_format_unsupported")}
            guard let stream=CMAudioFormatDescriptionGetStreamBasicDescription(description),stream.pointee.mChannelsPerFrame<=2,stream.pointee.mSampleRate<=48_000 else {throw Failure("media_resource_limit")}
            settings=[AVFormatIDKey:kAudioFormatLinearPCM,AVLinearPCMBitDepthKey:16,AVLinearPCMIsFloatKey:false,AVLinearPCMIsNonInterleaved:false]
        } else {throw Failure("media_format_unsupported")}
        let reader=try AVAssetReader(asset:asset)
        let output=AVAssetReaderTrackOutput(track:track,outputSettings:settings)
        output.alwaysCopiesSampleData=false
        guard reader.canAdd(output) else {throw Failure("media_video_invalid")}
        reader.add(output)
        guard reader.startReading() else {throw Failure("media_video_invalid")}
        var count=0;var end=0.0
        while let sample=output.copyNextSampleBuffer() {
            guard CMSampleBufferDataIsReady(sample),CMSampleBufferIsValid(sample) else {throw Failure("media_video_invalid")}
            let time=CMSampleBufferGetPresentationTimeStamp(sample).seconds
            let length=CMSampleBufferGetDuration(sample).seconds
            guard time.isFinite,time>=0 else {throw Failure("media_video_invalid")}
            if mediaType == .video {guard let pixel=CMSampleBufferGetImageBuffer(sample),CVPixelBufferGetWidth(pixel)>0,CVPixelBufferGetHeight(pixel)>0,Int64(CVPixelBufferGetWidth(pixel))*Int64(CVPixelBufferGetHeight(pixel))<=40_000_000 else {throw Failure("media_video_invalid")}}
            count+=CMSampleBufferGetNumSamples(sample)
            guard count<=(mediaType == .video ? 7200:6_000_000) else {reader.cancelReading();throw Failure("media_resource_limit")}
            end=max(end,time+(length.isFinite ? max(length,0):sampleStep))
        }
        guard reader.status == .completed,count>0 else {throw Failure("media_video_invalid")}
        let range=try await track.load(.timeRange)
        let expected=CMTimeRangeGetEnd(range).seconds
        guard end+0.1>=expected else {throw Failure("media_video_invalid")}
        if mediaType == .video {totalFrames=count}
    }
    guard videoCount==1 else {throw Failure("media_format_unsupported")}
    return ["format":"mp4","mimeType":"video/mp4","containerValid":true,"viewable":false,"playable":true,"frames":totalFrames]
}
@main struct Main {
    static func main() async {
        do {
            guard CommandLine.arguments.count==2 else {throw Failure("media_format_unsupported")}
            let data=try inputData()
            if CommandLine.arguments[1]=="image" {emit(try image(data))}
            if CommandLine.arguments[1]=="video" {emit(try await video(data))}
            throw Failure("media_format_unsupported")
        } catch let failure as Failure {emit(["error":failure.code],status:1)}
        catch {emit(["error":"media_validation_failed"],status:1)}
    }
}
