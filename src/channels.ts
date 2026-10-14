export const MRBEAST_CHANNEL_ID = 'UCX6OQ3DkcsbYNE6H8uQQuVA';
export const MRBEAST_GAMING_CHANNEL_ID = 'UCIPPMRA040LQr5QPyJEbmXA';
export const DEFAULT_CHANNEL_IDS = [MRBEAST_CHANNEL_ID, MRBEAST_GAMING_CHANNEL_ID] as const;

export function channelName(id: string): string {
  if (id === MRBEAST_CHANNEL_ID) return 'MrBeast';
  if (id === MRBEAST_GAMING_CHANNEL_ID) return 'MrBeast Gaming';
  return id;
}
