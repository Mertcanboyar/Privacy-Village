// Player identity chosen on the Title/CharacterCreate screens (see
// PLAN.md Phase 2, Day 1) plus faction (Day 3). Plain module singleton,
// not a framework store or Phaser's registry — matches
// config.ts/rooms.ts's style.
//
// Placeholder avatars: 5 static painted character sprites (no animation
// frames), used as the avatar picker options until real animated
// variants exist. baseScale targets the same ~75px-tall on-screen
// height already established for these sprites elsewhere (Room.ts's
// wizard and the Herald NPC's own sprite) — each option's source PNG
// is a different pixel height
// (single cropped idle frame from its source pack), so baseScale isn't
// a shared constant.

export interface AvatarOption {
  id: string;
  label: string;
  /** Phaser texture cache key, already loaded in Preload.ts. */
  texture: string;
  /** Public asset path for the DOM avatar-picker <img>. */
  imageSrc: string;
  baseScale: number;
}

// Target on-screen heights below are half of the original ~145-150px
// convention (now ~72-75px) — sprites read too large at that size,
// per feedback.
export const AVATAR_OPTIONS: AvatarOption[] = [
  { id: "wizard", label: "Wizard", texture: "player", imageSrc: "/assets/sprites/player/wizard.png", baseScale: 75 / 514 },
  { id: "knight", label: "Knight", texture: "npc-knight", imageSrc: "/assets/sprites/npc/knight.png", baseScale: 72.5 / 475 },
  { id: "paladin", label: "Paladin", texture: "player-paladin", imageSrc: "/assets/sprites/player/paladin.png", baseScale: 75 / 481 },
  { id: "archer", label: "Archer", texture: "player-archer", imageSrc: "/assets/sprites/player/archer.png", baseScale: 75 / 515 },
  { id: "viking", label: "Viking", texture: "player-viking", imageSrc: "/assets/sprites/player/viking.png", baseScale: 75 / 413 },
];

export type Faction = "fundamentalist" | "apocalypse";

export interface Session {
  name: string;
  avatarId: string;
  faction: Faction | null;
}

const DEFAULT_SESSION: Session = { name: "Traveler", avatarId: AVATAR_OPTIONS[0].id, faction: null };

let current: Session = { ...DEFAULT_SESSION };

export function getSession(): Session {
  return current;
}

/** Merges into the current session rather than replacing it — Day 1's
 * name+avatar and Day 3's faction are set at different points in the
 * CharacterCreate flow. */
export function setSession(partial: Partial<Session>) {
  current = { ...current, ...partial };
}

export function getAvatarOption(): AvatarOption {
  return AVATAR_OPTIONS.find((a) => a.id === current.avatarId) ?? AVATAR_OPTIONS[0];
}

/** Player name-tag color by faction (falls back to the default text
 * color if no faction is chosen — shouldn't happen post-CharacterCreate,
 * but Room.ts can be reached directly during testing). */
export function getFactionColor(): string {
  return factionColorFor(current.faction);
}

/** Same color mapping, for an arbitrary faction string rather than the
 * local session's — remote players carry their own faction over the
 * network (see net/NetClient.ts), so their name tags can't read from
 * `current`. */
export function factionColorFor(faction: string | null | undefined): string {
  if (faction === "fundamentalist") return "#f0b429"; // --accent-gold
  if (faction === "apocalypse") return "#ef476f"; // --accent-red
  return "#f2f0e9"; // --text-primary
}
