import {useEffect} from 'react';
import {listen} from '@tauri-apps/api/event';
import {native} from './bridge';
export type ScrollOperation='page_up'|'page_down'|'start'|'end';
export function scrollSurface(operation:ScrollOperation,element:HTMLElement) {
  const page=Math.max(80,element.clientHeight-48);
  const top=operation==='start'?0:operation==='end'?element.scrollHeight:element.scrollTop+(operation==='page_up'?-page:page);
  element.scrollTo({top,behavior:'instant'});
}
export function useKeyboardScroll(target:()=>HTMLElement|null){
  useEffect(()=>{
    const apply=(operation:ScrollOperation)=>{const element=target();if(element)scrollSurface(operation,element);};
    const keyboard=(event:KeyboardEvent)=>{
      if(!event.ctrlKey||!event.shiftKey||event.altKey||event.repeat)return;
      const operation=({PageUp:'page_up',PageDown:'page_down',Home:'start',End:'end'}as const)[event.key as 'PageUp'];
      if(operation){event.preventDefault();apply(operation);}
    };
    // Native global shortcuts suppress the local keydown, so use one route per environment.
    if(native()){
      let disposed=false;let off:(()=>void)|undefined;
      listen<ScrollOperation>('copilot:scroll',({payload})=>apply(payload)).then(unlisten=>{if(disposed)unlisten();else off=unlisten;});
      return()=>{disposed=true;off?.();};
    }
    window.addEventListener('keydown',keyboard);return()=>window.removeEventListener('keydown',keyboard);
  },[]);
}
