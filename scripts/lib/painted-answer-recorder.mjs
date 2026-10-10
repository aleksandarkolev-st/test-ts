// Runs inside the actual overlay. Geometry accounts for clipped/scrolling text.
export function installPaintedAnswerRecorder(){
 window.deepPaintObserver?.disconnect();
 window.deepPaintSamples??=[];
 let scheduled=false,last='';
 const sample=()=>{
  scheduled=false;
  const content=document.querySelector('.answer-content'),p=document.querySelector('.answer p[aria-live="polite"]');
  const text=p?.textContent??'',rect=p?.getBoundingClientRect(),style=p?getComputedStyle(p):null;
  let clip={top:0,left:0,right:innerWidth,bottom:innerHeight};
  for(let parent=p?.parentElement;parent;parent=parent.parentElement){
   const cs=getComputedStyle(parent),r=parent.getBoundingClientRect();
   if(/auto|scroll|hidden|clip/u.test(cs.overflowY)){clip.top=Math.max(clip.top,r.top);clip.bottom=Math.min(clip.bottom,r.bottom);}
   if(/auto|scroll|hidden|clip/u.test(cs.overflowX)){clip.left=Math.max(clip.left,r.left);clip.right=Math.min(clip.right,r.right);}
  }
  let visibleStart=0,visibleEnd=0;
  const node=p?.firstChild;
  if(node?.nodeType===Node.TEXT_NODE&&node.textContent.length&&rect&&clip.bottom>clip.top){
   const glyph=index=>{const range=document.createRange();range.setStart(node,index);range.setEnd(node,index+1);return range.getBoundingClientRect();};
   const firstIndex=predicate=>{let low=0,high=node.textContent.length;while(low<high){const mid=Math.floor((low+high)/2);if(predicate(glyph(mid)))high=mid;else low=mid+1;}return low;};
   visibleStart=firstIndex(r=>r.top>=clip.top);
   visibleEnd=firstIndex(r=>r.bottom>clip.bottom);
   if(visibleStart>=visibleEnd)visibleStart=visibleEnd=0;
  }
  const visible=Boolean(p&&rect.width>0&&rect.height>0&&style.visibility!=='hidden'&&style.display!=='none'&&document.visibilityState==='visible'&&visibleEnd>visibleStart);
  const record={recorderVersion:2,hostMs:Date.now(),questionId:content?.dataset.questionId??null,
   revision:Number(content?.dataset.responseRevision??0),text,visible,visibleStart,visibleEnd,clip,
   paragraphRect:rect&&{top:rect.top,bottom:rect.bottom,left:rect.left,right:rect.right},scrollTop:content?.scrollTop??null};
  const key=JSON.stringify([record.questionId,record.revision,text,visible,visibleStart,visibleEnd]);
  if(key!==last){window.deepPaintSamples.push(record);last=key;}
 };
 const observer=new MutationObserver(()=>{if(!scheduled){scheduled=true;requestAnimationFrame(()=>requestAnimationFrame(sample));}});
 observer.observe(document.querySelector('.answer-content'),{subtree:true,childList:true,characterData:true,attributes:true});
 window.deepPaintObserver=observer;sample();
}
