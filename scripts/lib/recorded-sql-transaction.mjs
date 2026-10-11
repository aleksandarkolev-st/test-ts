// Split transport scheduling boundaries without changing recorded SQL.
// Unsupported statement layouts remain harness limitations, not model failures.
function lexicalBoundaries(source){
 const masked=source.split(''),ends=[];
 const hide=(start,end)=>{for(let k=start;k<end;k++)if(!/[\r\n]/.test(masked[k]))masked[k]=' ';};
 for(let i=0;i<source.length;){
  const start=i;
  if(source.startsWith('--',i)){while(i<source.length&&!/[\r\n]/.test(source[i]))i++;hide(start,i);continue;}
  if(source.startsWith('/*',i)){
   let depth=1;i+=2;
   while(i<source.length&&depth){if(source.startsWith('/*',i)){depth++;i+=2;}else if(source.startsWith('*/',i)){depth--;i+=2;}else i++;}
   if(depth)return null;hide(start,i);continue;
  }
  if(source[i]==="'"||source[i]==='"'){
   const quote=source[i],escape=quote==="'"&&/[eE]/.test(source[i-1]??'')&&!/[A-Za-z0-9_$]/.test(source[i-2]??'');let closed=false;i++;
   while(i<source.length){if(escape&&source[i]==='\\'){i+=2;continue;}if(source[i]===quote){if(source[i+1]===quote){i+=2;continue;}i++;closed=true;break;}i++;}
   if(!closed)return null;hide(start,i);continue;
  }
  if(source[i]==='$'&&!/[A-Za-z0-9_$]/.test(source[i-1]??'')){
   const tag=/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(source.slice(i))?.[0];
   if(tag){const end=source.indexOf(tag,i+tag.length);if(end<0)return null;i=end+tag.length;hide(start,i);continue;}
  }
  if(source[i]===';')ends.push(i+1);i++;
 }
 return {masked:masked.join(''),ends};
}
export function recordedSqlTransaction(source){
 const lex=lexicalBoundaries(source);if(!lex||lex.ends.length<2)return null;
 const first=lex.ends[0],last=lex.ends.at(-1),commitStart=lex.ends.at(-2);
 if(!/^\s*BEGIN\b[\s\S]*;\s*$/i.test(lex.masked.slice(0,first))||
  !/^\s*COMMIT\s*;\s*$/i.test(lex.masked.slice(commitStart,last))||lex.masked.slice(last).trim())return null;
 return {begin:source.slice(0,first),body:source.slice(first,commitStart),commit:source.slice(commitStart)};
}
export function repeatableReadControlBegin(begin){
 // BEGIN admits transaction options, not string expressions. Mask comments
 // with equal-length spaces to locate the actual isolation token in source.
 const masked=lexicalBoundaries(begin)?.masked;if(masked==null)return null;
 const match=/\bISOLATION\s+LEVEL\s+(SERIALIZABLE)\b/i.exec(masked);
 if(!match)return null;
 const start=match.index+match[0].length-match[1].length;
 return begin.slice(0,start)+'REPEATABLE READ'+begin.slice(start+match[1].length);
}
