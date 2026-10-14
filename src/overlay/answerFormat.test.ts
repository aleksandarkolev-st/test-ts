import {describe,it,expect} from 'vitest';
import {answerParts,codeTokens} from './answerFormat';
describe('source-aware code snippets',()=>{
  it('keeps offsets across CRLF prose and multiple languages',()=>{const raw='Explain.\r\n```js\r\nconst x = 1;\r\n```\r\nThen:\n```python\ndef f():\n  return 2\n```';const parts=answerParts(raw);expect(parts.filter(p=>p.kind==='code').map(p=>p.language)).toEqual(['js','python']);for(const p of parts)expect(raw.slice(p.start,p.start+p.text.length)).toBe(p.text);});
  it('renders an incomplete streamed fence without hiding its code',()=>{const p=answerParts('Hi\n```js\nfunction solve(){\n');expect(p.at(-1)).toMatchObject({kind:'code',open:true,text:'function solve(){\n'});});
  it('does not treat ordinary technical prose as code',()=>expect(answerParts('The function should return a count.\nA class groups behavior.').every(p=>p.kind==='prose')).toBe(true));
  it('tokenization preserves source exactly and escapes no data into markup',()=>{const raw='const x = "<script>";\n// safe\nreturn x;';const t=codeTokens(raw,7);expect(t.map(x=>x.text).join('')).toBe(raw);for(const x of t)expect(raw.slice(x.start-7,x.start-7+x.text.length)).toBe(x.text);});
});
