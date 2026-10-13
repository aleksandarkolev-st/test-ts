// Evaluation-only environment substitution. This module is never imported by
// the application. All additions, shuffles, masks and control flow stay exact.
export function adaptRecordedPhysicalLaneRead(code) {
 const laneRead=/\basm\s*(?:volatile\s*)?\(\s*"mov\.u32 %0, %%laneid;"\s*:\s*"=r"\s*\(\s*([A-Za-z_][A-Za-z_0-9]*)\s*\)\s*\)\s*;/g;
 const executable=cppExecutableOffsets(code);
 let replacements=0;
 const source=code.replace(laneRead,(original,variable,offset)=>{
  if(!executable[offset])return original;
  replacements++;return `${variable} = threadIdx.x;`;
 });
 return {source,ptxLaneReadsReplaced:replacements,algorithmRepaired:false,
  scope:'Only a recorded mov.u32 physical lane-id read is mapped to the test-only CPU lane. Other PTX remains unsupported and unchanged. This is not nvcc or NVIDIA execution.'};
}

// Recognize comments and C++ quoted/raw literals so a displayed example or
// string constant cannot be rewritten into a different runtime value.
function cppExecutableOffsets(code) {
 const mask=new Uint8Array(code.length).fill(1);
 for(let i=0;i<code.length;){
  const start=i;let end=null;
  if(code.startsWith('//',i)){end=code.indexOf('\n',i+2);if(end<0)end=code.length;}
  else if(code.startsWith('/*',i)){end=code.indexOf('*/',i+2);end=end<0?code.length:end+2;}
  else if(code.startsWith('R"',i)){
   const raw=/^R"([^\s()\\]{0,16})\(/.exec(code.slice(i));
   if(raw){const closing=')'+raw[1]+'"';end=code.indexOf(closing,i+raw[0].length);end=end<0?code.length:end+closing.length;}
  }
  if(end===null&&(code[i]==='"'||code[i]==="'")){
   const quote=code[i];end=i+1;
   while(end<code.length){if(code[end]==='\\'){end+=2;continue;}if(code[end++]===quote)break;}
   end=Math.min(end,code.length);
  }
  if(end!==null){mask.fill(0,start,end);i=end;}else i++;
 }
 return mask;
}
