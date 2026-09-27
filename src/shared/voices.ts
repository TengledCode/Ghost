// Shortlisted stock voices for a warm, articulate, lightly playful male voice. They are chosen for
// timbre only (no cloning), and the Ghost filter adds the synthetic shimmer on top.
export interface VoiceOption { id: string; label: string; note: string }

export const EDGE_VOICES: VoiceOption[] = [
  { id: 'en-US-AndrewMultilingualNeural', label: 'Andrew (US)', note: 'Warm, articulate, confident. Closest overall timbre.' },
  { id: 'en-US-BrianMultilingualNeural', label: 'Brian (US)', note: 'Bright, youthful, slightly playful.' },
  { id: 'en-US-ChristopherNeural', label: 'Christopher (US)', note: 'Firm, measured, authoritative.' },
  { id: 'en-GB-RyanNeural', label: 'Ryan (UK)', note: 'Crisp and courteous, suits the tailor manner.' },
];

// ElevenLabs default-library voice IDs (available on the free tier).
export const ELEVENLABS_VOICES: VoiceOption[] = [
  { id: 'TX3LPaxmHKxFdv7VOQHJ', label: 'Liam', note: 'Energetic, articulate young male.' },
  { id: 'cjVigY5qzO86Huf0OWal', label: 'Eric', note: 'Smooth, trustworthy, composed.' },
  { id: 'iP95p4xoKVk53GoZ742B', label: 'Chris', note: 'Natural, friendly, down-to-earth.' },
  { id: 'nPczCjzI2devNBz1zQrb', label: 'Brian', note: 'Deep, resonant, polished.' },
];
