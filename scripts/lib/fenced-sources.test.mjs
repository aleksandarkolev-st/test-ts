import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fencedSources} from './fenced-sources.mjs';

test('preserves CRLF, indentation, Unicode and longer closing fences',()=>{
 assert.deepEqual(fencedSources('preface\r\n  ```cpp\r\n  Ω <= μ;\r\n````\r\nafter'),[
  {text:'  Ω <= μ;\r\n',languageAnnotation:'cpp'}]);
});
test('shorter or mixed markers stay inside the body; unterminated blocks excluded',()=>{
 assert.deepEqual(fencedSources('````cpp\na\n```\n~~~\nb\n````\n~~~rust\nunclosed'),[
  {text:'a\n```\n~~~\nb\n',languageAnnotation:'cpp'}]);
});
test('tilde fences, empty bodies and EOF closing fence are supported',()=>{
 assert.deepEqual(fencedSources('~~~js\n~~~\n```text\nx\n```'),[
  {text:'',languageAnnotation:'js'},{text:'x\n',languageAnnotation:'text'}]);
});
