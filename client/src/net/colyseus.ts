import { Client, Room, getStateCallbacks } from "colyseus.js";

export { getStateCallbacks };

// colyseus.js@0.16.x pins @colyseus/schema ^3.0.0 — the server must stay on
// the matching colyseus@0.16.x / @colyseus/schema@3.x line (see server's
// package.json) or state sync silently breaks.
const COLYSEUS_URL = import.meta.env.VITE_COLYSEUS_URL ?? "ws://localhost:2567";

export interface VillageJoinOptions {
  name: string;
  spriteId: string;
}

export async function joinVillage(options: VillageJoinOptions): Promise<Room> {
  const client = new Client(COLYSEUS_URL);
  return client.joinOrCreate("village", options);
}
