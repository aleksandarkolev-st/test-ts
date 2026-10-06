import { create } from 'zustand';
import { initialSnapshot, type Snapshot } from './model';
interface Store { snapshot: Snapshot; apply: (s: Snapshot) => void }
export const useMeeting = create<Store>((set) => ({ snapshot: initialSnapshot, apply: (snapshot) => set((state) => snapshot.revision >= state.snapshot.revision ? { snapshot } : state) }));
