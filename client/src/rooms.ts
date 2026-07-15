// The 3 rooms of the painted-scene architecture (see CLAUDE.md).
export const ROOMS = ["village", "tavern", "courthouse"] as const;
export type RoomName = (typeof ROOMS)[number];
