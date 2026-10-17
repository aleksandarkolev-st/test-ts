import {describe,it,expect} from 'vitest';
import {monitorLabel,monitorTone,monitorTitle} from './monitorFormat';
import type {MonitorStatus} from '../state/model';
const base:MonitorStatus={state:'watching',question:null,answerCached:false,focus:false,typed:false,warning:null,window:null,executable:null,updatedAt:0,analyzedFrames:0,solutions:0};
describe('screen monitor chip',()=>{
  it('summarizes watching, reading, focused, and found-question states',()=>{
    expect(monitorLabel(base)).toBe('Watching authorized apps');
    expect(monitorLabel({...base,state:'analyzing'})).toBe('Reading the screen…');
    expect(monitorLabel({...base,focus:true})).toBe('Focused field watched');
    expect(monitorLabel({...base,question:'What is 2 + 2?'})).toBe('Question found');
    expect(monitorLabel({...base,answerCached:true})).toBe('Answer ready for the field');
    expect(monitorLabel({...base,typed:true})).toBe('Answer typed into the field');
  });
  it('surfaces warnings and errors with a warning tone, and never claims success while typed is false',()=>{
    const failed={...base,state:'error' as const,warning:'No authorized app was in front'};
    expect(monitorLabel(failed)).toBe('No authorized app was in front');
    expect(monitorTone(failed)).toBe('warn');
    expect(monitorTone(base)).toBe('idle');
    expect(monitorTone({...base,answerCached:true})).toBe('busy');
    expect(monitorTone({...base,typed:true})).toBe('done');
  });
  it('titles include the question, app, counts, and the automated-input disclosure',()=>{
    const title=monitorTitle({...base,question:'Q',executable:'notepad.exe',analyzedFrames:4,solutions:2,warning:'Typing was refused'});
    expect(title).toContain('Question: Q');
    expect(title).toContain('notepad.exe');
    expect(title).toContain('4 frames analyzed');
    expect(title).toContain('Typing was refused');
    expect(title).toContain('automated keyboard input');
  });
});
