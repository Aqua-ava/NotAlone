import romanceCatalog from '../../../../reply-skills/romance/catalog.json' with {type:'json'};

const romancePresentation=new Map(romanceCatalog.entries.map(item=>[item.name,{title:item.title,tags:[item.category]}]));

/** 按 Skill 包名查询面向用户的中文标题和分类；目录之外的包没有展示信息。 */
export function skillPresentation(name:string):{title:string;tags:string[]}|undefined {
 return romancePresentation.get(name);
}
