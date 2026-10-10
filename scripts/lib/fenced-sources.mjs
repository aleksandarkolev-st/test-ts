// Preserve fenced bodies byte-for-byte; no language or content-based rewriting.
export function fencedSources(answer) {
 const lines=[...answer.matchAll(/[^\n]*\n|[^\n]+$/gu)],blocks=[];
 let open=null;
 for(const line of lines){
  const raw=line[0],text=raw.replace(/\r?\n$/u,''),offset=line.index;
  if(open){
   const close=/^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(text);
   if(close&&close[1][0]===open.marker&&close[1].length>=open.length){
    blocks.push({text:answer.slice(open.bodyStart,offset),languageAnnotation:open.annotation});open=null;
   }
  }else{
   const start=/^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(text);
   if(start&&(start[1][0]!=='`'||!start[2].includes('`'))){
    open={marker:start[1][0],length:start[1].length,annotation:start[2].trim(),bodyStart:offset+raw.length};
   }
  }
 }
 return blocks;
}
