// Split transport scheduling boundaries without changing recorded SQL.
// Unsupported statement layouts remain harness limitations, not model failures.
const trivia=String.raw`(?:\s|--[^\r\n]*(?:\r?\n|$)|/\*[\s\S]*?\*/)*`;
const transaction=new RegExp(`^(${trivia}BEGIN\\b[^;]*;)([\\s\\S]*?)(COMMIT\\s*;${trivia})$`,'i');
export function recordedSqlTransaction(source){
 const match=source.match(transaction);
 return match?{begin:match[1],body:match[2],commit:match[3]}:null;
}
export function repeatableReadControlBegin(begin){
 // BEGIN admits transaction options, not string expressions. Mask comments
 // with equal-length spaces to locate the actual isolation token in source.
 const masked=begin.replace(/--[^\r\n]*|\/\*[\s\S]*?\*\//g,comment=>comment.replace(/[^\r\n]/g,' '));
 const match=/\bISOLATION\s+LEVEL\s+(SERIALIZABLE)\b/i.exec(masked);
 if(!match)return null;
 const start=match.index+match[0].length-match[1].length;
 return begin.slice(0,start)+'REPEATABLE READ'+begin.slice(start+match[1].length);
}
