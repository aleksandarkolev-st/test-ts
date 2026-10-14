import vm from 'node:vm';
import {isDeepStrictEqual} from 'node:util';
const entry=(id,title,contract,source,cases,oracle)=>({id,title,contract,source,cases,oracle});
export const bugs=[
 entry('search-boundary','Sorted insertion service','Return the first index whose value is >= target, or nums.length when none exists. Empty input returns zero.',
  'function solve(nums,target){let lo=0,hi=nums.length-1;while(lo<hi){const mid=Math.floor((lo+hi)/2);if(nums[mid]<target)lo=mid+1;else hi=mid;}return lo;}',
  [[[1,3,5],3],[[1,3,5],6],[[],1],[[2],3]],(a,t)=>{const i=a.findIndex(x=>x>=t);return i<0?a.length:i;}),
 entry('duplicate-search','First-match search service','Return the leftmost index equal to target in ascending nums, or -1.',
  'function solve(nums,target){let lo=0,hi=nums.length-1;while(lo<=hi){const mid=(lo+hi)>>1;if(nums[mid]===target)return mid;if(nums[mid]<target)lo=mid+1;else hi=mid-1;}return -1;}',
  [[[1,3,5],3],[[2,2,2,2,2],2],[[1,2,2,3],2],[[],1]],(a,t)=>a.indexOf(t)),
 entry('bounded-queue','Queue admission service','Simulate capacity>=0 and push/pop operations. Each push returns whether admitted; pop returns FIFO value or null. Never exceed capacity.',
  'function solve(capacity,operations){const q=[],out=[];for(const [op,v]of operations){if(op==="push"){if(q.length>capacity)out.push(false);else{q.push(v);out.push(true);}}else out.push(q.length?q.shift():null);}return out;}',
  [[2,[['push',1],['pop']]],[1,[['push',1],['push',2],['pop']]],[0,[['push',1],['pop']]]],(capacity,ops)=>{const q=[];return ops.map(([op,v])=>op==='push'?(q.length<capacity?(q.push(v),true):false):q.length?q.shift():null);} ),
 entry('lru-recency','Recently used cache','Simulate positive capacity and put/get operations. Gets return value or -1. Gets and replacement puts both refresh recency.',
  'function solve(capacity,ops){const m=new Map(),out=[];for(const[op,k,v]of ops){if(op==="get")out.push(m.has(k)?m.get(k):-1);else{m.delete(k);m.set(k,v);if(m.size>capacity)m.delete(m.keys().next().value);}}return out;}',
  [[2,[['put','a',1],['get','a']]],[2,[['put','a',1],['put','b',2],['get','a'],['put','c',3],['get','b']]],[1,[['put','a',0],['get','a']]]],(capacity,ops)=>{const m=new Map(),out=[];for(const[op,k,v]of ops){if(op==='get'){if(!m.has(k))out.push(-1);else{const x=m.get(k);m.delete(k);m.set(k,x);out.push(x);}}else{m.delete(k);m.set(k,v);if(m.size>capacity)m.delete(m.keys().next().value);}}return out;}),
 entry('ttl-expiry','Time-limited cache','Operations [time,put,key,value,ttl] or [time,get,key]. A key is absent at now>=putTime+ttl. Return get results with null misses.',
  'function solve(ops){const m=new Map(),out=[];for(const[t,op,k,v,ttl]of ops){if(op==="put")m.set(k,{v,end:t+ttl});else{const x=m.get(k);out.push(!x||t>x.end?null:x.v);}}return out;}',
  [[[ [0,'put','a',7,5],[1,'get','a'] ]],[[[0,'put','a',7,5],[5,'get','a']]],[[[2,'put','x',0,0],[2,'get','x']]]],ops=>{const m=new Map(),out=[];for(const[t,op,k,v,ttl]of ops){if(op==='put')m.set(k,{v,end:t+ttl});else{const x=m.get(k);out.push(x&&t<x.end?x.v:null);}}return out;}),
 entry('window-reset','Request quota service','Accept at most limit events in each fixed floor(time/windowMs) window; return acceptance booleans for nondecreasing times.',
  'function solve(times,limit,windowMs){let last=-1,count=0;return times.map(t=>{if(t!==last){count=0;last=t;}return count++<limit;});}',
  [[[0,0,0],2,10],[[0,1,2],2,10],[[9,10,11],1,10]],(times,limit,w)=>{const counts=new Map();return times.map(t=>{const key=Math.floor(t/w),n=counts.get(key)??0;counts.set(key,n+1);return n<limit;});}),
 entry('event-identity','Event accounting service','Apply each first-seen event id exactly once. Return {total,acceptedIds} with first-seen order. An id may be any string including inherited object property names.',
  'function solve(events){const seen={},acceptedIds=[];let total=0;for(const{id,delta}of events){if(!seen[id]){seen[id]=true;total+=delta;acceptedIds.push(id);}}return{total,acceptedIds};}',
  [[[ {id:'a',delta:2},{id:'a',delta:9} ]],[[{id:'toString',delta:4}]],[[{id:'__proto__',delta:5},{id:'b',delta:1}]]],events=>{const seen=new Set(),acceptedIds=[];let total=0;for(const{id,delta}of events)if(!seen.has(id)){seen.add(id);total+=delta;acceptedIds.push(id);}return{total,acceptedIds};}),
 entry('reservation-transaction','Inventory reservation service','For stock {sku:quantity} and positive-integer item quantities, return {accepted,stock}. A rejected order must leave stock unchanged, including duplicate SKUs.',
  'function solve(stock,items){stock={...stock};try{for(const{sku,quantity}of items){if(!Number.isInteger(quantity)||quantity<=0||(stock[sku]??0)<quantity)throw Error("rejected");stock[sku]-=quantity;}return{accepted:true,stock};}catch{return{accepted:false,stock};}}',
  [[{A:3},[{sku:'A',quantity:1}]],[{A:3,B:1},[{sku:'A',quantity:1},{sku:'B',quantity:2}]],[{A:3},[{sku:'A',quantity:2},{sku:'A',quantity:2}]]],(stock,items)=>{const totals=new Map();for(const{sku,quantity}of items){if(!Number.isInteger(quantity)||quantity<=0)return{accepted:false,stock:{...stock}};totals.set(sku,(totals.get(sku)??0)+quantity);}for(const[k,n]of totals)if((stock[k]??0)<n)return{accepted:false,stock:{...stock}};const result={...stock};for(const[k,n]of totals)result[k]-=n;return{accepted:true,stock:result};}),
 entry('csv-escaping','Delimited record service','Parse one valid CSV row; quoted commas are literal and doubled quotes inside a quoted field represent one quote.',
  'function solve(row){const fields=[];let field="",quoted=false;for(const ch of row){if(ch===String.fromCharCode(34))quoted=!quoted;else if(ch===","&&!quoted){fields.push(field);field="";}else field+=ch;}fields.push(field);return fields;}',
  [['a,b'],['"a,b",c'],['"a""b",c'],[',']],row=>{const out=[];let s='',q=false;for(let i=0;i<row.length;i++){const c=row[i];if(c==='"'){if(q&&row[i+1]==='"'){s+='"';i++;}else q=!q;}else if(c===','&&!q){out.push(s);s='';}else s+=c;}out.push(s);return out;}),
 entry('signed-division','Integer arithmetic service','Return integer quotient truncating toward zero for integer a and nonzero b.',
  'function solve(a,b){return Math.floor(a/b);}',[[7,3],[-7,3],[7,-3],[-7,-3],[0,2]],(a,b)=>Math.trunc(a/b)),
 entry('opening-brackets','Bracket validation service','Validate nesting and balancing of (), [], {}. Empty input is valid.',
  'function solve(s){const st=[],pairs={")":"(","]":"[","}":"{"};for(const c of s){if("([{ ".trim().includes(c))st.push(c);else if(st.pop()!==pairs[c])return false;}return true;}',
  [['()'],['('],['([]'],['([)]'],['']],s=>{const st=[],pairs={')':'(',']':'[','}':'{'};for(const c of s)if('([{'.includes(c))st.push(c);else if(st.pop()!==pairs[c])return false;return!st.length;}),
 entry('shortest-path-settlement','Directed routing service','Return shortest directed distances from source with nonnegative weighted edges [from,to,weight], and null for unreachable vertices.',
  'function solve(n,edges,source){const d=Array(n).fill(Infinity),seen=new Set([source]),q=[[0,source]];d[source]=0;while(q.length){q.sort((a,b)=>a[0]-b[0]);const[c,u]=q.shift();for(const[a,b,w]of edges)if(a===u&&!seen.has(b)){seen.add(b);d[b]=c+w;q.push([d[b],b]);}}return d.map(x=>Number.isFinite(x)?x:null);}',
  [[3,[[0,1,1],[1,2,2]],0],[3,[[0,1,10],[0,2,1],[2,1,1]],0],[2,[],0]],(n,edges,s)=>{const d=Array(n).fill(Infinity);d[s]=0;for(let k=0;k<n-1;k++)for(const[a,b,w]of edges)d[b]=Math.min(d[b],d[a]+w);return d.map(x=>Number.isFinite(x)?x:null);}),
 entry('dependency-completion','Dependency planning service','Return the lexicographically smallest topological ordering of directed vertices 0..n-1, or [] for a cycle.',
  'function solve(n,edges){const degree=Array(n).fill(0),out=[];for(const[a,b]of edges)degree[b]++;const q=[];for(let i=0;i<n;i++)if(!degree[i])q.push(i);while(q.length){q.sort((a,b)=>a-b);const u=q.shift();out.push(u);for(const[a,b]of edges)if(a===u&&!--degree[b])q.push(b);}return out.length===n-1?out:[];}',
  [[2,[[0,1]]],[1,[]],[3,[[0,1],[1,2]]],[2,[[0,1],[1,0]]]],(n,edges)=>{const out=[],remaining=new Set(Array.from({length:n},(_,i)=>i));while(remaining.size){const x=[...remaining].filter(u=>!edges.some(([a,b])=>b===u&&remaining.has(a))).sort((a,b)=>a-b)[0];if(x===undefined)return[];remaining.delete(x);out.push(x);}return out;}),
 entry('meeting-endpoint','Room allocation service','Return minimum rooms for half-open positive-length intervals; an end at time t permits a start at t.',
  'function solve(intervals){const events=intervals.flatMap(([a,b])=>[[a,1],[b,-1]]).sort((a,b)=>a[0]-b[0]||b[1]-a[1]);let count=0,best=0;for(const[t,delta]of events)best=Math.max(best,count+=delta);return best;}',
  [[[[0,2],[1,3]]],[[[0,1],[1,2]]],[[[0,1],[1,2],[2,3]]],[[]]],a=>{const e=a.flatMap(([x,y])=>[[x,1],[y,-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);let n=0,m=0;for(const[,d]of e)m=Math.max(m,n+=d);return m;}),
 entry('unicode-iteration','Character counting service','Return the number of distinct Unicode code points in a string; surrogate pairs represent one code point.',
  'function solve(s){return new Set(s.split("")).size;}',[['abc'],['😀'],['😀😃'],['😀😀'],['']],s=>new Set([...s]).size),
 entry('cache-zero','Value lookup service','Given a key/value object and a list of keys, return values or -1 for absent keys. Stored zero, false, empty string and null remain valid values.',
  'function solve(values,keys){return keys.map(k=>values[k]||-1);}',[[{a:2},['a','b']],[{a:0,b:false,c:'',d:null},['a','b','c','d']],[{},['toString']]],(o,ks)=>ks.map(k=>Object.hasOwn(o,k)?o[k]:-1)),
 entry('zero-product','Exclusion product service','Return product of all array entries except each entry itself; handle one or multiple zeros without division.',
  'function solve(nums){const all=nums.reduce((a,b)=>a*b,1);return nums.map(x=>all/x);}',[[[1,2,3]],[[0,2,3]],[[0,2,0]],[[1]]],a=>a.map((_,i)=>a.reduce((n,v,j)=>j===i?n:n*v,1))),
 entry('window-multiplicity','Character-window service','Return the shortest substring of s containing all of t with multiplicity; choose leftmost on ties; impossible returns empty.',
  'function solve(s,t){const need=new Set(t);let best="";for(let i=0;i<s.length;i++)for(let j=i+1;j<=s.length;j++){const w=s.slice(i,j);if([...need].every(c=>w.includes(c))&&(!best||w.length<best.length))best=w;}return best;}',
  [['ABC','AB'],['AAB','AA'],['AB','AA'],['BAAA','AA']],(s,t)=>{const n={};for(const c of t)n[c]=(n[c]??0)+1;let best='';for(let i=0;i<s.length;i++)for(let j=i+1;j<=s.length;j++){const w=s.slice(i,j);if(Object.entries(n).every(([c,k])=>[...w].filter(x=>x===c).length>=k)&&(!best||w.length<best.length))best=w;}return best;}),
 entry('stable-order','Priority record service','Sort records {key,id} by ascending numeric key, preserving input order for equal keys. Return the sorted records without mutating input.',
  'function solve(records){const a=records.map(x=>({...x}));for(let i=1;i<a.length;i++){let j=i;while(j>0&&a[j-1].key>=a[j].key){[a[j],a[j-1]]=[a[j-1],a[j]];j--;}}return a;}',
  [[[ {key:2,id:'b'},{key:1,id:'a'} ]],[[{key:1,id:'a'},{key:1,id:'b'}]],[[]]],a=>a.map((v,i)=>({v,i})).sort((a,b)=>a.v.key-b.v.key||a.i-b.i).map(x=>x.v)),
 entry('root-path','Absolute path service','Normalize absolute slash-delimited paths. Ignore dot and empty segments; dot-dot removes a preceding segment without going above root.',
  'function solve(path){const st=[];for(const p of path.split("/")){if(!p||p===".")continue;if(p===".."&&st.length)st.pop();else st.push(p);}return"/"+st.join("/");}',
  [['/a/../b'],['/../a'],['/../../'],['/a//./b/..']],p=>{const st=[];for(const x of p.split('/'))if(x==='..')st.pop();else if(x&&x!=='.')st.push(x);return'/'+st.join('/');})
].map((bug,index)=>({...bug,index:index+1,rounds:[
 'Read the attached project and identify its context marker. Under its contract, find the correctness bug, cite the exact source file and expression, and produce a smallest valid counterexample with actual versus required behavior. Do not implement yet.',
 'Fix the project bug. Return a complete replacement for src/core.mjs defining export function solve with the same argument contract. No dependencies, test edits or API changes. Explain the invariant restored.',
 'Try to falsify your fix with at least three boundary cases, including a rejected or empty case where the contract allows it. Correct any flaw and return the final complete src/core.mjs implementation. Keep the same public contract.'
]}));
export function checkBug(bug,source){
 const context=vm.createContext({}, {codeGeneration:{strings:false,wasm:false}});let passed=0;const failures=[];
 try{vm.runInContext(source.replace(/\bexport\s+(?=(?:async\s+)?function|class|const|let)/g,''),context,{timeout:1500});}catch(e){return{passed:false,passedCases:0,totalCases:bug.cases.length,error:String(e)};}
 for(const args of bug.cases){const expected=bug.oracle(...structuredClone(args));context.args=structuredClone(args);try{const raw=vm.runInContext('solve(...args)',context,{timeout:1500});const actual=JSON.parse(JSON.stringify(raw));if(isDeepStrictEqual(actual,expected))passed++;else failures.push({args,expected,actual});}catch(e){failures.push({args,expected,error:String(e)});}}
 return{passed:passed===bug.cases.length,passedCases:passed,totalCases:bug.cases.length,failures};
}
