// Fully visible source characters, in browser UTF-16 coordinates. Keeping
// viewport evidence separate avoids calling clipped output an already seen cue.
export function visibleAnswerRange(p: HTMLParagraphElement): [number, number] {
  const text = p.firstChild;
  const style = getComputedStyle(p);
  if (document.visibilityState !== 'visible' || style.visibility === 'hidden' || style.display === 'none' || text?.nodeType !== Node.TEXT_NODE) return [0, 0];
  const value = text.textContent ?? '';
  const clip = { top: 0, bottom: innerHeight, left: 0, right: innerWidth };
  for (let parent = p.parentElement; parent; parent = parent.parentElement) {
    const css = getComputedStyle(parent), rect = parent.getBoundingClientRect();
    if (/auto|scroll|hidden|clip/.test(css.overflowY)) { clip.top = Math.max(clip.top, rect.top); clip.bottom = Math.min(clip.bottom, rect.bottom); }
    if (/auto|scroll|hidden|clip/.test(css.overflowX)) { clip.left = Math.max(clip.left, rect.left); clip.right = Math.min(clip.right, rect.right); }
  }
  const rect = p.getBoundingClientRect();
  if (!value || rect.width <= 0 || clip.bottom <= clip.top || rect.right <= clip.left || rect.left >= clip.right) return [0, 0];
  const boundary = (predicate: (r: DOMRect) => boolean) => {
    let low = 0, high = value.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2), range = document.createRange();
      range.setStart(text, middle); range.setEnd(text, middle + 1);
      if (predicate(range.getBoundingClientRect())) high = middle; else low = middle + 1;
    }
    return low;
  };
  let start = boundary(r => r.top >= clip.top), end = boundary(r => r.bottom > clip.bottom);
  // Never split a surrogate pair at a viewport boundary.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(value[start] ?? '')) start++;
  if (end > 0 && /[\uDC00-\uDFFF]/.test(value[end] ?? '')) end--;
  return start < end ? [start, end] : [0, 0];
}
// Rich content retains original UTF-16 offsets, including omitted Markdown fences.
// Clip each mapped text segment against every scrolling ancestor. Never count
// Copy controls, hidden raw source, or code outside a horizontal viewport.
export function visibleAnswerRanges(root:HTMLElement):Array<[number,number]>{
  if(document.visibilityState!=='visible')return[];
  const ranges:Array<[number,number]>=[];
  for(const element of root.querySelectorAll<HTMLElement>('[data-source-start]')){
    const text=element.firstChild;if(text?.nodeType!==Node.TEXT_NODE)continue;
    const css=getComputedStyle(element);if(css.visibility==='hidden'||css.display==='none')continue;
    const clip={top:0,bottom:innerHeight,left:0,right:innerWidth};
    for(let parent=element.parentElement;parent;parent=parent.parentElement){const style=getComputedStyle(parent),rect=parent.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(style.overflowY)){clip.top=Math.max(clip.top,rect.top);clip.bottom=Math.min(clip.bottom,rect.bottom);}if(/auto|scroll|hidden|clip/.test(style.overflowX)){clip.left=Math.max(clip.left,rect.left);clip.right=Math.min(clip.right,rect.right);}}
    const rect=element.getBoundingClientRect();if(rect.bottom<=clip.top||rect.top>=clip.bottom||rect.right<clip.left||rect.left>clip.right)continue;
    const value=text.textContent??'',start=Number(element.dataset.sourceStart);if(!value||!Number.isFinite(start))continue;
    if(rect.top>=clip.top&&rect.bottom<=clip.bottom&&rect.left>=clip.left&&rect.right<=clip.right){ranges.push([start,start+value.length]);continue;}
    let run=-1;
    for(let i=0;i<value.length;i++){
      const range=document.createRange();range.setStart(text,i);range.setEnd(text,i+1);const r=range.getBoundingClientRect();
      const visible=r.top>=clip.top&&r.bottom<=clip.bottom&&r.left>=clip.left&&r.right<=clip.right;
      if(visible&&run<0)run=i;
      if(run>=0&&(!visible||i===value.length-1)){let a=run,b=visible?i+1:i;if(/[\uDC00-\uDFFF]/.test(value[a]??''))a++;if(/[\uDC00-\uDFFF]/.test(value[b]??''))b--;if(a<b)ranges.push([start+a,start+b]);run=-1;}
    }
  }
  ranges.sort((a,b)=>a[0]-b[0]);const merged:Array<[number,number]>=[];
  for(const r of ranges){const prior=merged.at(-1);if(prior&&r[0]<=prior[1])prior[1]=Math.max(prior[1],r[1]);else merged.push([...r]);}return merged;
}
