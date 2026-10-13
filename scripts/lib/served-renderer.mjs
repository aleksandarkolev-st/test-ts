import {createHash} from 'node:crypto';
export async function servedRenderer(origin='http://127.0.0.1:1420'){
 const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
 const html=await fetch(origin).then(r=>r.text());
 const scripts=[...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m=>m[1]);
 const bundles=[];
 for(const file of scripts){const bytes=Buffer.from(await fetch(new URL(file,origin)).then(r=>r.arrayBuffer()));bundles.push({file,sha256:sha(bytes)});}
 return {origin,htmlSha256:sha(html),bundles,scope:'Actual served renderer shared by native variant comparisons; native core binaries remain separate.'};
}
