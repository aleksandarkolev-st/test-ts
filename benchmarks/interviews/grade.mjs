import vm from 'node:vm';
import {isDeepStrictEqual} from 'node:util';
import {fixtures} from './cases.mjs';
import {gradeCode as gradeLeetCode} from '../context-handoff/oracles.mjs';
import {checkBug} from './bugs.mjs';

export function extractCode(answer,bug=false){
 const blocks=[...answer.matchAll(/(?:```|~~~)(?:javascript|js|typescript|mjs)?\s*\n([\s\S]*?)(?:```|~~~)/g)].map(m=>m[1]);
 const source=blocks.find(b=>/\b(?:function\s+solve|(?:const|let|var)\s+solve\s*=)/.test(b))??blocks[0]??answer;
 return bug?source:source.replace(/\bexport\s+(?=(?:async\s+)?function|class|const|let)/g,'');
}
export function gradeInterview(id,source){
 if(id.startsWith('algorithm-'))return {...gradeLeetCode(Number(id.slice(10)),source),scope:'functional fixtures; complexity requires separate review'};
 const cases=fixtures[id];if(!cases)throw Error('Missing frozen fixture set: '+id);
 const failures=[];let passedCases=0;
 // Each case is isolated. Serialize arguments inside the realm so candidate code
 // receives no host object with a Node constructor chain.
 for(const {args,expected} of cases){
  const context=vm.createContext({}, {codeGeneration:{strings:false,wasm:false}});
  try{
   const encoded=JSON.stringify(JSON.stringify(args));
   const script=source+'\n;const __args=JSON.parse('+encoded+');const __value=solve(...__args);'+
    'function __check(v){if(v===undefined||typeof v==="function"||typeof v==="symbol"||typeof v==="bigint"||(typeof v==="number"&&!Number.isFinite(v)))throw Error("Non-JSON result");if(v&&typeof v==="object"){for(const x of Array.isArray(v)?v:Object.values(v))__check(x);}}__check(__value);JSON.stringify(__value);';
   const raw=vm.runInContext(script,context,{timeout:1500});
   const actual=JSON.parse(raw);
   if(isDeepStrictEqual(actual,expected))passedCases++;else failures.push({args,expected,actual});
  }catch(error){failures.push({args,expected,error:String(error)});}
 }
 return{passed:passedCases===cases.length,passedCases,totalCases:cases.length,failures,scope:'307 frozen functional fixtures across 75 scenarios; no complexity claim'};
}
export function gradeBug(bug,source){
 const grade=checkBug(bug,source);
 // The bug interviews promise the same synchronous public function.
 const contractOkay=/\bexport\s+function\s+solve\s*\(/.test(source)&&!/\basync\s+function\s+solve/.test(source)&&!/\bimport\s/.test(source);
 return {...grade,contractOkay,passed:grade.passed&&contractOkay};
}
