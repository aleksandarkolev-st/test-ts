import {useMemo,useState} from 'react';
import {answerParts,codeTokens,type AnswerPart} from './answerFormat';
function CodeBlock({part}:{part:AnswerPart}){
  const [copiedText,setCopiedText]=useState<string|null>(null);const [error,setError]=useState('');
  const tokens=useMemo(()=>codeTokens(part.text,part.start),[part.text,part.start]);
  return <section className="code-block" aria-label={`${part.language} code snippet`}>
    <div className="code-toolbar"><span>{part.language}{part.open?' · streaming':''}</span><button aria-label="Copy code" onClick={async()=>{try{await navigator.clipboard.writeText(part.text);setCopiedText(part.text);setError('');}catch{setError('Copy unavailable. Select the code to copy it.');}}}>{copiedText===part.text?'Copied':'Copy code'}</button></div>
    <pre tabIndex={0} aria-label="Code snippet"><code>{tokens.map((token,i)=><span key={i} data-source-start={token.start} className={token.style?`syntax-${token.style}`:undefined}>{token.text}</span>)}</code></pre>
    {error&&<p role="status" className="copy-error">{error}</p>}
  </section>;
}
export default function FormattedAnswer({text}:{text:string}){
  const parts=useMemo(()=>answerParts(text),[text]);
  return <div className="answer-body" data-raw-answer={text} aria-live="polite" aria-atomic="false">{parts.map((part,i)=>part.kind==='code'?<CodeBlock key={`${i}:${part.start}`} part={part}/>:<p key={`${i}:${part.start}`} data-source-start={part.start}>{part.text}</p>)}</div>;
}
