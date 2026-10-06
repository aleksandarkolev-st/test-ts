export type SpeakerSource = 'self' | 'remote';
export interface TranscriptSegment { id: string; source: SpeakerSource; text: string; startedAt: number; endedAt: number; final: boolean }
export interface CurrentQuestion { id: string; text: string; detectedAt: number }
export interface Latency { speechStoppedAt: number; transcriptFinalAt: number; questionConfirmedAt: number; requestSentAt: number; firstTokenAt: number | null; completedAt: number | null }
export interface Snapshot {
  revision: number; active: boolean; paused: boolean;
  status: 'off' | 'listening' | 'question' | 'thinking' | 'answer' | 'error';
  question: CurrentQuestion | null; answer: string; error: string | null;
  protection: boolean; expanded: boolean; manual: boolean; latency: Latency | null;
  remoteLevel: number; selfLevel: number;
}
export interface Settings { microphone: string; output: string; modelPath: string; model: string; reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | null }
export interface AudioDevice { id: string; name: string; source: SpeakerSource; default: boolean }
export interface Account { clientId: string; email: string | null; name: string | null; planEnabled: boolean }
export interface Model { slug: string; display_name: string }
export interface Bootstrap { settings: Settings; devices: AudioDevice[]; accounts: Account[]; selected: Account | null; models: Model[]; snapshot: Snapshot; debug: boolean; shortcutErrors: string[] }
export const initialSnapshot: Snapshot = { revision: 0, active: false, paused: false, status: 'off', question: null, answer: '', error: null, protection: false, expanded: false, manual: false, latency: null, remoteLevel: 0, selfLevel: 0 };
