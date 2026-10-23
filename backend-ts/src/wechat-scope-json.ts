/** 保留旧授权JSON合同：重复键、坏UTF-8或空正文都不能被解释为确认。 */
export function parseWechatScopeJson(input: string | Buffer): unknown {
  const text = Buffer.isBuffer(input) ? new TextDecoder('utf-8',{fatal:true}).decode(input) : input;
  const value: unknown = JSON.parse(text);
  const scopes: (Set<string> | null)[] = [];
  // JSON.parse已验证语法；词法扫描只补它不会拒绝的同对象重复键。
  const tokens = /"(?:\\.|[^"\\])*"|[{}\[\]]/g;
  for (let token; (token = tokens.exec(text)) !== null;) {
    if (token[0] === '{') scopes.push(new Set());
    else if (token[0] === '[') scopes.push(null);
    else if (token[0] === '}' || token[0] === ']') scopes.pop();
    else {
      let next = tokens.lastIndex;
      while (/\s/.test(text[next] ?? '') && next < text.length) next++;
      if (text[next] !== ':') continue;
      const keys = scopes.at(-1);
      const key = JSON.parse(token[0]) as string;
      if (!keys || keys.has(key)) throw new Error('invalid_json');
      keys.add(key);
    }
  }
  return value;
}
