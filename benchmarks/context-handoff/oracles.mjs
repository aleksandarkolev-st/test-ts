import vm from 'node:vm';
import {isDeepStrictEqual} from 'node:util';
import {problems} from './catalog.mjs';
const pal=s=>s===[...s].reverse().join('');
const rectangle=a=>{let best=0;for(let i=0;i<a.length;i++){let h=Infinity;for(let j=i;j<a.length;j++){h=Math.min(h,a[j]);best=Math.max(best,h*(j-i+1));}}return best;};
export const oracles={
 4:(a,b)=>{const s=[...a,...b].sort((x,y)=>x-y),n=s.length;return(s[(n-1)>>1]+s[n>>1])/2;},
 10:(s,p)=>new RegExp(`^(?:${p})$`).test(s),
 32:s=>{let best=0;for(let i=0;i<s.length;i++){let n=0;for(let j=i;j<s.length;j++){n+=s[j]==='('?1:-1;if(n<0)break;if(!n)best=Math.max(best,j-i+1);}}return best;},
 42:a=>a.reduce((n,h,i)=>n+Math.max(0,Math.min(Math.max(0,...a.slice(0,i)),Math.max(0,...a.slice(i+1)))-h),0),
 44:(s,p)=>new RegExp(`^(?:${[...p].map(c=>c==='*'?'.*':c==='?'?'.':c).join('')})$`).test(s),
 76:(s,t)=>{let best='';const need={};for(const c of t)need[c]=(need[c]??0)+1;for(let i=0;i<s.length;i++){const have={};for(let j=i;j<s.length;j++){have[s[j]]=(have[s[j]]??0)+1;if(Object.keys(need).every(c=>have[c]>=need[c])){const w=s.slice(i,j+1);if(!best||w.length<best.length)best=w;break;}}}return best;},
 84:rectangle,
 85:m=>{let best=0;for(let top=0;top<m.length;top++){const a=Array(m[0].length).fill(1);for(let bottom=top;bottom<m.length;bottom++){for(let c=0;c<a.length;c++)a[c]&=m[bottom][c]==='1';let run=0;for(const x of a){run=x?run+1:0;best=Math.max(best,run*(bottom-top+1));}}}return best;},
 115:(s,t)=>{let count=0;function go(i,j){if(j===t.length){count++;return;}for(let k=i;k<s.length;k++)if(s[k]===t[j])go(k+1,j+1);}go(0,0);return count;},
 132:s=>{const dp=Array(s.length+1).fill(Infinity);dp[0]=-1;for(let j=1;j<=s.length;j++)for(let i=0;i<j;i++)if(pal(s.slice(i,j)))dp[j]=Math.min(dp[j],dp[i]+1);return dp[s.length];},
 239:(a,k)=>Array.from({length:a.length-k+1},(_,i)=>Math.max(...a.slice(i,i+k))),
 312:a=>{const memo=new Map();function go(xs){if(!xs.length)return 0;const key=xs.join(',');if(memo.has(key))return memo.get(key);let n=0;for(let i=0;i<xs.length;i++)n=Math.max(n,(xs[i-1]??1)*xs[i]*(xs[i+1]??1)+go([...xs.slice(0,i),...xs.slice(i+1)]));memo.set(key,n);return n;}return go(a);},
 315:a=>a.map((v,i)=>a.slice(i+1).filter(x=>x<v).length),
 329:m=>{let best=0;function go(r,c){let n=1;for(const[dr,dc]of[[1,0],[-1,0],[0,1],[0,-1]]){const rr=r+dr,cc=c+dc;if(rr>=0&&rr<m.length&&cc>=0&&cc<m[0].length&&m[rr][cc]>m[r][c])n=Math.max(n,1+go(rr,cc));}return n;}for(let r=0;r<m.length;r++)for(let c=0;c<m[0].length;c++)best=Math.max(best,go(r,c));return best;},
 493:a=>{let n=0;for(let i=0;i<a.length;i++)for(let j=i+1;j<a.length;j++)if(a[i]>2*a[j])n++;return n;},
 3:s=>{let n=0;for(let i=0;i<s.length;i++){const seen=new Set();for(let j=i;j<s.length&&!seen.has(s[j]);j++){seen.add(s[j]);n=Math.max(n,j-i+1);}}return n;},
 33:(a,t)=>a.indexOf(t),
 56:a=>{const s=a.map(x=>[...x]).sort((a,b)=>a[0]-b[0]),out=[];for(const x of s){const last=out.at(-1);if(last&&x[0]<=last[1])last[1]=Math.max(last[1],x[1]);else out.push(x);}return out;},
 200:m=>{const seen=new Set();let n=0;function visit(r,c){const key=`${r},${c}`;if(r<0||c<0||r>=m.length||c>=m[0].length||m[r][c]!=='1'||seen.has(key))return;seen.add(key);visit(r-1,c);visit(r+1,c);visit(r,c-1);visit(r,c+1);}for(let r=0;r<m.length;r++)for(let c=0;c<m[0].length;c++)if(m[r][c]==='1'&&!seen.has(`${r},${c}`)){n++;visit(r,c);}return n;},
 322:(coins,n)=>{const seen=new Set([0]);let q=[0],depth=0;while(q.length){const next=[];for(const x of q){if(x===n)return depth;for(const c of coins)if(x+c<=n&&!seen.has(x+c)){seen.add(x+c);next.push(x+c);}}q=next;depth++;}return-1;},
 1:(a,t)=>{for(let i=0;i<a.length;i++)for(let j=i+1;j<a.length;j++)if(a[i]+a[j]===t)return[i,j];throw Error('invalid two sum fixture');},
 20:s=>{const stack=[],pair={')':'(',']':'[','}':'{'};for(const c of s)if('([{'.includes(c))stack.push(c);else if(stack.pop()!==pair[c])return false;return!stack.length;},
 121:a=>{let n=0;for(let i=0;i<a.length;i++)for(let j=i+1;j<a.length;j++)n=Math.max(n,a[j]-a[i]);return n;},
 217:a=>a.some((x,i)=>a.indexOf(x)!==i),
 704:(a,t)=>a.indexOf(t)
};
let seed=20261014;
const random=()=>{seed=(Math.imul(1664525,seed)+1013904223)>>>0;return seed/2**32;};
const int=(n,offset=0)=>Math.floor(random()*n)+offset;
const array=(n,max=10,offset=0)=>Array.from({length:n},()=>int(max,offset));
const str=(n,alphabet='abc')=>Array.from({length:n},()=>alphabet[int(alphabet.length)]).join('');
export function casesFor(id){
 seed=20261014+id;
 const p=problems.find(p=>p.id===id),rows=p.examples.map(([args,expected])=>({args,expected,kind:'example'}));
 for(let i=0;i<70;i++){
  let args;const n=int(13);
  switch(id){
   case 4:{const a=array(n,21,-10).sort((a,b)=>a-b),b=array(int(12)+1,21,-10).sort((a,b)=>a-b);args=[a,b];break;}
   case 10:{let pattern='';for(let j=0;j<int(7);j++)pattern+=str(1,'abc.')+(random()<.4?'*':'');args=[str(n),pattern];break;}
   case 32:args=[str(n,'()')];break;
   case 42:case 84:args=[array(n)];break;
   case 44:args=[str(n),str(int(9),'abc?*')];break;
   case 76:args=[str(n,'ABC'),str(int(5)+1,'ABC')];break;
   case 85:case 200:args=[Array.from({length:int(5)+1},()=>Array.from({length:4},()=>str(1,'01')))];break;
   case 115:args=[str(n),str(int(6))];break;
   case 132:args=[str(n+1)];break;
   case 239:args=[array(n+1,21,-10),int(n+1)+1];break;
   case 312:args=[array(int(7),6)];break;
   case 315:case 493:args=[array(n,21,-10)];break;
   case 329:args=[Array.from({length:int(4)+1},()=>array(4,10))];break;
   case 3:args=[str(n)];break;
   case 33:{const a=[...new Set(array(n,30,-10))].sort((a,b)=>a-b),k=int(a.length||1);args=[[...a.slice(k),...a.slice(0,k)],int(30,-10)];break;}
   case 56:args=[Array.from({length:n},()=>{const x=int(15);return[x,x+int(8)];})];break;
   case 322:args=[[...new Set(array(int(5)+1,9,1))],int(40)];break;
   case 1:{const a=[...new Set(array(8,100,-50))];if(a.length<2){i--;continue;}const t=a[0]+a[1];let hits=0;for(let x=0;x<a.length;x++)for(let y=x+1;y<a.length;y++)if(a[x]+a[y]===t)hits++;if(hits!==1){i--;continue;}args=[a,t];break;}
   case 20:args=[str(n,'()[]{}')];break;
   case 121:args=[array(n,30)];break;
   case 217:args=[array(n,8,-4)];break;
   case 704:args=[[...new Set(array(n,30,-10))].sort((a,b)=>a-b),int(30,-10)];break;
  }
  rows.push({args,expected:oracles[id](...structuredClone(args)),kind:'seeded'});
 }
 const extras={4:[[[0,0],[0,0]]],10:[['','a*'],['aaa','a*a'],['ab','.*c']],32:[[''],['()(()'],['()(())']],42:[[[4,2,0,3,2,5]]],44:[['','*'],['','?']],76:[['AAABBC','AABC'],['a','aa']],84:[[[2,2,2]],[[1,2,3,4]]],85:[[[]]],115:[['abc','']],132:[['ababbbabbababa']],239:[[[2,2,2,2],2]],312:[[[1,0,2]]],315:[[[2,2,1]]],329:[[[[7,7],[7,7]]]],493:[[[2147483647,2147483647,-2147483648]], [[-5,-5]]],3:[['']],33:[[[],1]],56:[[[[1,4],[4,5]]]],200:[[[]]],322:[[[2],0],[[2],3]],1:[[[3,3],6]],20:[['']],121:[[[9,8,7]]],217:[[[]]],704:[[[],1]]};
 for(const args of extras[id]??[])rows.push({args,expected:oracles[id](...structuredClone(args)),kind:'edge'});
 return rows;
}
export function gradeCode(id,code){
 const context=vm.createContext({}, {codeGeneration:{strings:false,wasm:false}});
 try{vm.runInContext(`${code}\nif (typeof solve !== 'function') throw new Error('Missing solve function');`,context,{timeout:1500});}catch(e){return{passed:false,compileError:String(e),passedCases:0,totalCases:casesFor(id).length};}
 let passed=0;const failures=[];const rows=casesFor(id);
 for(const row of rows){
  try{context.args=structuredClone(row.args);const raw=vm.runInContext('solve(...args)',context,{timeout:1500});const actual=JSON.parse(JSON.stringify(raw));
   let equal=isDeepStrictEqual(actual,row.expected);
   if(id===1)equal=Array.isArray(actual)&&actual.length===2&&Number.isInteger(actual[0])&&Number.isInteger(actual[1])&&actual[0]!==actual[1]&&actual.every(i=>i>=0&&i<row.args[0].length)&&row.args[0][actual[0]]+row.args[0][actual[1]]===row.args[1];
   if(id===76){const [s,t]=row.args;equal=typeof actual==='string'&&actual.length===row.expected.length&&s.includes(actual)&&[...new Set(t)].every(c=>[...actual].filter(x=>x===c).length>=[...t].filter(x=>x===c).length);if(row.expected==='')equal=actual==='';}
   if(equal)passed++;else if(failures.length<5)failures.push({...row,actual});
  }catch(e){if(failures.length<5)failures.push({...row,error:String(e)});}
 }
 return{passed:passed===rows.length,passedCases:passed,totalCases:rows.length,failures,scope:'Functional correctness on examples, edge cases, and 70 seeded small inputs; complexity reviewed separately.'};
}
