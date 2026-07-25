// The 4 rooms of the painted-scene architecture (see CLAUDE.md).
export const ROOMS = ["village", "tavern", "courthouse", "great_hall"] as const;
export type RoomName = (typeof ROOMS)[number];
