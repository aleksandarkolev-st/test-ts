export interface AnswerPart {kind:'prose'|'code';text:string;start:number;language?:string;open?:boolean}
export function answerParts(source:string):AnswerPart[]{
  const parts:AnswerPart[]=[];const fence=/^([ \t]*)(`{3,}|~{3,})([^\r\n]*)\r?\n/gm;let cursor=0;let match:RegExpExecArray|null;
  while((match=fence.exec(source))){
    if(match.index<cursor)continue;
    if(match.index>cursor)parts.push({kind:'prose',text:source.slice(cursor,match.index),start:cursor});
    const bodyStart=fence.lastIndex;const closing=new RegExp(`^[ \\t]*${match[2][0]}{${match[2].length},}[ \\t]*(?:\\r?\\n|$)`,'gm');closing.lastIndex=bodyStart;
    const end=closing.exec(source);const bodyEnd=end?.index??source.length;
    parts.push({kind:'code',text:source.slice(bodyStart,bodyEnd),start:bodyStart,language:match[3].trim().split(/\s/)[0]?.toLowerCase()||'text',open:!end});
    cursor=end?closing.lastIndex:source.length;fence.lastIndex=cursor;if(!end)break;
  }
  if(cursor<source.length)parts.push({kind:'prose',text:source.slice(cursor),start:cursor});
  if(!parts.length&&source)parts.push({kind:'prose',text:source,start:0});
  // Unfenced snippets must exhibit code structure, not merely a technical word.
  return parts.flatMap(part=>{
    if(part.kind!=='prose')return[part];
    const lines=part.text.split(/(?<=\n)/);let offset=part.start;const result:AnswerPart[]=[];let code:AnswerPart|undefined;
    for(const line of lines){
      const begins=/^\s*(?:(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(|(?:export\s+)?class\s+\w+\s*[{:]|def\s+\w+\s*\(|(?:const|let|var)\s+\w+\s*=|SELECT\s+.+\s+FROM\s+)/i.test(line);
      if(begins&&!code)code={kind:'code',text:'',start:offset,language:/^\s*def\s/.test(line)?'python':/^\s*SELECT\s/i.test(line)?'sql':'javascript'};
      if(code&&(begins||/^\s*(?:[}\])];?|(?:return|if|for|while|else|const|let|var)\b|\/\/|#|\s{2,}\S)/.test(line)||!line.trim()))code.text+=line;
      else{if(code){result.push(code);code=undefined;}result.push({kind:'prose',text:line,start:offset});}
      offset+=line.length;
    }
    if(code)result.push(code);return result;
  });
}
export interface SourceToken {text:string;start:number;style?:string}
export function codeTokens(text:string,start:number):SourceToken[]{
  const pattern=/(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:function|return|const|let|var|if|else|for|while|class|new|async|await|throw|try|catch|export|import|from|def|elif|in|True|False|None|SELECT|FROM|WHERE|JOIN|GROUP|BY|ORDER|AS|AND|OR|NULL)\b|\b\d+(?:\.\d+)?\b)/g;
  const tokens:SourceToken[]=[];let cursor=0;let match:RegExpExecArray|null;
  const append=(value:string,offset:number,style?:string)=>{let position=offset;for(const line of value.split(/(?<=\n)/)){if(line)tokens.push({text:line,start:position,style});position+=line.length;}};
  while((match=pattern.exec(text))){if(match.index>cursor)append(text.slice(cursor,match.index),start+cursor);const value=match[0];append(value,start+match.index,/^(\/\/|#|\/\*)/.test(value)?'comment':/^["'`]/.test(value)?'string':/^\d/.test(value)?'number':'keyword');cursor=pattern.lastIndex;}
  if(cursor<text.length)append(text.slice(cursor),start+cursor);return tokens;
}
