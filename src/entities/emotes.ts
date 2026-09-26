/** Clip names are validated by CharacterRig before playback. Extend this registry for new assets. */
export const EMOTES: Record<string, { clip: string; from: number; seconds: number }> = {
  dance: { clip: 'dance', from: 0, seconds: 8 },
  'dance-short': { clip: 'dance', from: 0, seconds: 3 },
  'dance-finish': { clip: 'dance', from: 3, seconds: 3 },
};
