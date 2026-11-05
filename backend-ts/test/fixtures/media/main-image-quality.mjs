import {createHash} from 'node:crypto';

// 合成夹具：来源依据明确为标准图（main）的图片质量字段；记忆只带入确认不是缩略图的图片。
export const mainImageQuality=bytes=>({imageQuality:'unknown',qualityProof:null,imageQualityEvidence:{protocol:'wechat-image-quality-v1',quality:'unknown',
 sourceVariant:'main',resourceInfoId:'10',resources:[{resourceId:'20',resourceTypeRaw:131073}],sourceSha256:'a'.repeat(64),
 contentSha256:createHash('sha256').update(bytes).digest('hex'),originalProofDigest:null}});
