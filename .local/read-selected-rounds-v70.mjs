import {readFile} from 'node:fs/promises';
const journal=JSON.parse(await readFile('artifacts/deep-interview-v70/algorithms-hour-t/interview.json'));
for(const round of process.argv.slice(2).map(Number)){
 const row=journal.rows.find(row=>row.round===round);
 console.log(JSON.stringify({round,question:row?.question,answer:row?.answer}));
}
