import { createScanner, SyntaxKind as K } from 'typescript/unstable/ast';
import { diagnosticEvents } from '../../src/diagnostics/unified-contract.mjs';

// 使用锁定 TypeScript 7 的纯 JS 词法接口，不启动原生编译器服务。
// 这里只识别具名调用和对象顶层字段，不推断变量、展开、别名或任意控制流。
const names = new Set(['diagnose', 'recordUnifiedDiagnostic']);
const regexPrefixes = new Set([':', '=', ',', '(', '[', 'return', '=>', '?', '||', '&&', '??', '!', ';']);
function tokenize(source) {
  const scanner = createScanner(true, undefined, source), tokens = [], templates = []; let braces = 0;
  for (let kind = scanner.scan(); kind !== K.EndOfFile; kind = scanner.scan()) {
    // 锁定版本的独立 # 会返回零长度 PrivateIdentifier；官方重扫将其消费为 HashToken。
    if (kind === K.PrivateIdentifier && scanner.getTokenEnd() === scanner.getTokenStart()) kind = scanner.reScanHashToken();
    if (scanner.getTokenEnd() <= scanner.getTokenStart()) throw new Error('诊断调用点扫描未推进');
    if (kind === K.CloseBraceToken && templates.at(-1) === braces) {
      kind = scanner.reScanTemplateToken(false);
      if (kind === K.TemplateTail) templates.pop();
    } else if (kind === K.TemplateHead) templates.push(braces);
    else if (kind === K.OpenBraceToken) braces++;
    else if (kind === K.CloseBraceToken) braces--;
    if (kind === K.SlashToken && (!tokens.length || regexPrefixes.has(tokens.at(-1).text))) kind = scanner.reScanSlashToken();
    tokens.push({ kind, text: scanner.getTokenText(), value: scanner.getTokenValue(), offset: scanner.getTokenStart() });
  }
  return tokens;
}
const closing = token => token.kind === K.TemplateHead ? 'template' : ({ '{': '}', '(': ')', '[': ']' })[token.text];
function objectProperties(tokens, open) {
  const properties = [], stack = []; let start = open + 1;
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i];
    if (!stack.length && token.text === '}') { properties.push(tokens.slice(start, i)); return properties; }
    if (!stack.length && token.text === ',') { properties.push(tokens.slice(start, i)); start = i + 1; continue; }
    const end = closing(token);
    if (end) stack.push(end);
    else if (token.text === stack.at(-1) || token.kind === K.TemplateTail && stack.at(-1) === 'template') stack.pop();
  }
}
const literalValue = token => token && [K.StringLiteral, K.NoSubstitutionTemplateLiteral].includes(token.kind) ? token.value : undefined;
function propertyName(token) {
  if (!token) return;
  if ([K.StringLiteral, K.NumericLiteral, K.Identifier].includes(token.kind)) return token.value;
  if (token.kind >= K.FirstKeyword && token.kind <= K.LastKeyword) return token.text;
}
function property(segment) {
  if (!segment.length) return;
  if (segment[0].kind === K.DotDotDotToken) return { dynamic: true };
  let key, colon;
  if (segment[0].text === '[' && segment[2]?.text === ']') { key = literalValue(segment[1]); colon = 3; }
  else { key = propertyName(segment[0]); colon = 1; }
  if (key === undefined) return { dynamic: true };
  if (segment[colon]?.text !== ':') return { key, dynamic: key === 'event' };
  let value = segment.slice(colon + 1);
  if (value.at(-2)?.text === 'as' && value.at(-1)?.text === 'const') value = value.slice(0, -2);
  while (value[0]?.text === '(' && value.at(-1)?.text === ')') value = value.slice(1, -1);
  return { key, event: value.length === 1 ? literalValue(value[0]) : undefined };
}
export function scanDiagnosticCallSites(source) {
  const tokens = tokenize(source), sites = [], violations = []; let deferredCalls = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!names.has(token.value) || tokens[i - 1]?.text === 'function') continue;
    let next = i + 1;
    if (token.kind === K.StringLiteral) {
      if (tokens[i - 1]?.text !== '[' || tokens[next]?.text !== ']') continue;
      next++;
    } else if (token.kind !== K.Identifier) continue;
    if (tokens[next]?.text === '?.') next++;
    if (tokens[next]?.text !== '(') continue;
    next++;
    if (tokens[next]?.text !== '{') { deferredCalls++; continue; }
    const parts = objectProperties(tokens, next);
    if (!parts) { deferredCalls++; continue; }
    const properties = parts.map(property).filter(Boolean), fields = properties.map(item => item.key).filter(key => key !== undefined);
    const eventProperty = properties.findLast(item => item.key === 'event'), event = eventProperty?.event;
    const site = { event, fields, offset: token.offset }; sites.push(site);
    if (event === undefined || properties.some(item => item.dynamic)) deferredCalls++;
    if (!eventProperty && !properties.some(item => item.dynamic)) { violations.push({ reason: 'missing_event', offset: token.offset }); continue; }
    if (event === undefined) continue;
    if (!Object.hasOwn(diagnosticEvents, event)) { violations.push({ event, reason: 'unregistered_event', offset: token.offset }); continue; }
    const allowed = new Set(['event', 'module', ...diagnosticEvents[event].fields]);
    for (const key of fields) if (!allowed.has(key)) violations.push({ event, key, reason: 'unknown_field', offset: token.offset });
  }
  return { sites, violations, deferredCalls };
}
