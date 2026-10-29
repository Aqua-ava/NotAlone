import Foundation

// ImageIO允许部分截短文件；先检查已支持容器的完整字节边界，再实际解码。
func imageContainer(_ data:Data,format:String) throws -> Int? {
    func fail() throws -> Never {throw Failure("media_image_invalid")}
    func u16(_ i:Int)->Int {Int(data[i])|(Int(data[i+1])<<8)}
    func u32(_ i:Int)->UInt64 {data[i..<i+4].reduce(0){($0<<8)|UInt64($1)}}
    func le32(_ i:Int)->Int64 {Int64(data[i])|(Int64(data[i+1])<<8)|(Int64(data[i+2])<<16)|(Int64(data[i+3])<<24)}
    if format=="png" {
        guard data.count>=33,Array(data.prefix(8))==[137,80,78,71,13,10,26,10] else {try fail()}
        let table=(0..<256).map { value -> UInt32 in
            var crc=UInt32(value)
            for _ in 0..<8 {crc=(crc&1)==1 ? (crc>>1)^0xedb88320:crc>>1}
            return crc
        }
        var cursor=8;var header=false;var body=false
        while cursor<data.count {
            guard data.count-cursor>=12 else {try fail()}
            let length=u32(cursor)
            guard length<=UInt64(data.count-cursor-12) else {try fail()}
            let size=Int(length)
            var crc:UInt32=0xffffffff
            for byte in data[cursor+4..<cursor+8+size] {crc=(crc>>8)^table[Int((crc^UInt32(byte))&0xff)]}
            guard UInt64(crc^0xffffffff)==u32(cursor+8+size) else {try fail()}
            let name=String(data:data[cursor+4..<cursor+8],encoding:.ascii) ?? ""
            if !header {guard name=="IHDR",size==13 else {try fail()};header=true}
            else if name=="IHDR" {try fail()}
            if let first=name.utf8.first,first>=65,first<=90,!["IHDR","PLTE","IDAT","IEND"].contains(name) {throw Failure("media_format_unsupported")}
            if name=="acTL" {throw Failure("media_format_unsupported")}
            if name=="IDAT" {body=true}
            cursor+=12+size
            if name=="IEND" {guard size==0,body,cursor==data.count else {try fail()};return 1}
        }
        try fail()
    }
    if format=="jpeg" {
        guard data.count>=4,data[0]==0xff,data[1]==0xd8,data[data.count-2]==0xff,data[data.count-1]==0xd9 else {try fail()}
        return 1
    }
    if format=="gif" {
        guard data.count>=14,["GIF87a","GIF89a"].contains(String(data:data.prefix(6),encoding:.ascii) ?? "") else {try fail()}
        var cursor=13
        if data[10]&0x80 != 0 {cursor+=3*(1<<Int((data[10]&7)+1))}
        var frames=0
        func subblocks() throws {
            while cursor<data.count {
                let size=Int(data[cursor]);cursor+=1
                if size==0 {return}
                guard size<=data.count-cursor else {try fail()}
                cursor+=size
            }
            try fail()
        }
        while cursor<data.count {
            let marker=data[cursor];cursor+=1
            if marker==0x3b {guard frames>0,cursor==data.count else {try fail()};return frames}
            if marker==0x21 {guard cursor<data.count else {try fail()};cursor+=1;try subblocks();continue}
            guard marker==0x2c,data.count-cursor>=9 else {try fail()}
            let width=u16(cursor+4);let height=u16(cursor+6)
            guard width>0,height>0,width*height<=40_000_000 else {throw Failure("media_resource_limit")}
            let packed=data[cursor+8];cursor+=9
            if packed&0x80 != 0 {cursor+=3*(1<<Int((packed&7)+1))}
            guard cursor<data.count,(2...8).contains(data[cursor]) else {try fail()}
            cursor+=1;try subblocks();frames+=1
            guard frames<=120 else {throw Failure("media_resource_limit")}
        }
        try fail()
    }
    if format=="bmp" {
        guard data.count>=54,data[0]==0x42,data[1]==0x4d,le32(2)==data.count else {try fail()}
        let dib=le32(14);let offset=le32(10)
        guard [40,108,124].contains(dib),offset>=14+dib,offset<=data.count,u16(26)==1,[24,32].contains(u16(28)),[0,3].contains(le32(30)) else {throw Failure("media_format_unsupported")}
        if le32(30)==3 {guard dib>=108,u16(28)==32,le32(54)==0x00ff0000,le32(58)==0x0000ff00,le32(62)==0x000000ff,le32(66)==0xff000000 else {throw Failure("media_format_unsupported")}}
        let width=le32(18);let signedHeight=Int64(Int32(bitPattern:UInt32(le32(22))))
        let height=abs(signedHeight)
        guard width>0,width<=40_000_000,height>0,height<=40_000_000 else {throw Failure("media_resource_limit")}
        let rowBytes=((width*Int64(u16(28))+31)/32)*4
        guard rowBytes*height<=Int64(data.count)-offset else {try fail()}
        return 1
    }
    throw Failure("media_format_unsupported")
}
