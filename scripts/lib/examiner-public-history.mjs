export function examinerPublicHistory(rows,current,latest,introduction){
 let text=introduction;
 for(const row of rows){
  if(row===current)break;
  const id=row.responseVersion?.split(':')[0],job=latest.get(id);
  const answer=job?.answer??row.answer??'';
  text+=`\nINTERVIEWER: ${row.question}\nACTUAL EARLIER CANDIDATE ANSWER OBSERVED BEFORE THIS REVIEW${job?.running?' (still streaming)':''}${job?.cancelled?' (cancelled)':''}: ${answer}\n`;
 }
 return text;
}
