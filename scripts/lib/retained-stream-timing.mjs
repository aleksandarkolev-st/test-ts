// Request-clock callback measurements. These are not native overlay timings.
export function retainedStreamTiming(events,answer,phrase=null){
 let text='',firstRetainedTextMs=null,firstRetainedWordMs=null,firstRetainedPhraseMs=null;
 const phraseStart=typeof phrase==='string'&&phrase.length?answer.indexOf(phrase):-1;
 const phraseEnd=phraseStart>=0?phraseStart+phrase.length:null;
 // A replacement retires the previous stream revision, even when an early
 // word happens to be identical. Measure the final recorded revision only.
 const lastReplacement=events.findLastIndex(event=>typeof event.revision==='string');
 for(const event of events.slice(Math.max(0,lastReplacement))){
  if(typeof event.revision==='string')text=event.revision;
  else if(typeof event.delta==='string')text+=event.delta;
  else continue;
  if(!Number.isFinite(event.atMs)||!text||!answer.startsWith(text))continue;
  firstRetainedTextMs??=event.atMs;
  const word=text.match(/[\p{L}\p{N}_]+(?:['’_-][\p{L}\p{N}_]+)*/u);
  if(word&&word.index+word[0].length<text.length&&
   !/[\p{L}\p{N}_'’\-]/u.test(text[word.index+word[0].length]))firstRetainedWordMs??=event.atMs;
  if(phraseEnd!==null&&text.length>=phraseEnd)firstRetainedPhraseMs??=event.atMs;
 }
 return {firstRetainedTextMs,firstRetainedWordMs,firstRetainedPhraseMs,phraseCharacterRange:phraseStart>=0?[phraseStart,phraseEnd]:null};
}
