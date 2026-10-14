import {writeFile} from 'node:fs/promises';
import {problems} from './catalog.mjs';
const rows=[];
for(const p of problems){
  const response=await fetch('https://leetcode.com/graphql/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'query questionData($titleSlug: String!) { question(titleSlug: $titleSlug) { questionFrontendId title difficulty titleSlug } }',variables:{titleSlug:p.slug}})});
  let data;try{data=await response.json();}catch{}
  const q=data?.data?.question;
  rows.push({id:p.id,url:p.url,retrievedAt:new Date().toISOString(),httpStatus:response.status,metadata:q??null,verified:q?.difficulty===p.difficulty&&Number(q.questionFrontendId)===p.id});
  console.log(p.id,response.status,q?.difficulty??'unavailable');
}
await writeFile(new URL('./sources.json',import.meta.url),JSON.stringify(rows,null,2)+'\n');
if(rows.some(r=>!r.verified))process.exitCode=1;
