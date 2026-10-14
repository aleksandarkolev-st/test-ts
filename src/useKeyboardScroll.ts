import {useEffect} from 'react';
import {listen} from '@tauri-apps/api/event';
import {native} from './bridge';
export type ScrollOperation='page_up'|'page_down'|'start'|'end'|'left'|'right';
export function scrollSurface(operation:ScrollOperation,element:HTMLElement) {
  if(operation==='left'||operation==='right'){
    const bounds=element.getBoundingClientRect();
    const focused=document.activeElement?.closest('pre');
    const code=focused&&element.contains(focused)?focused:Array.from(element.querySelectorAll('pre')).find(pre=>{const r=pre.getBoundingClientRect();return r.top<bounds.bottom&&r.bottom>bounds.top;});
    if(code)code.scrollTo({left:code.scrollLeft+(operation==='left'?-1:1)*Math.max(80,code.clientWidth-48),behavior:'instant'});
    return;
  }
  const focused=document.activeElement;
  if(focused instanceof HTMLElement && element.contains(focused) && focused.matches('[data-keyboard-scroll]')) element=focused;
  const page=Math.max(80,element.clientHeight-48);
  const top=operation==='start'?0:operation==='end'?element.scrollHeight:element.scrollTop+(operation==='page_up'?-page:page);
  element.scrollTo({top,behavior:'instant'});
}
export function useKeyboardScroll(target:()=>HTMLElement|null){
  useEffect(()=>{
    const apply=(operation:ScrollOperation)=>{const element=target();if(element)scrollSurface(operation,element);};
    const keyboard=(event:KeyboardEvent)=>{
      if(!event.ctrlKey||!event.shiftKey||event.altKey||event.repeat)return;
      const operation=({PageUp:'page_up',PageDown:'page_down',Home:'start',End:'end',ArrowLeft:'left',ArrowRight:'right'}as const)[event.key as 'PageUp'];
      if(operation){event.preventDefault();apply(operation);}
    };
    // Native global shortcuts suppress the local keydown, so use one route per environment.
    if(native()){
      let disposed=false;let off:(()=>void)|undefined;
      listen<ScrollOperation>('copilot:scroll',({payload})=>apply(payload)).then(unlisten=>{if(disposed)unlisten();else off=unlisten;}).catch(error=>console.error('Unable to listen for reading shortcuts',error));
      return()=>{disposed=true;off?.();};
    }
    window.addEventListener('keydown',keyboard);return()=>window.removeEventListener('keydown',keyboard);
  },[]);
}
