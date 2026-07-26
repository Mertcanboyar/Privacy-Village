import Phaser from "phaser";
import { inject } from "@vercel/analytics";
import "./style.css";
import { GAME_WIDTH, GAME_HEIGHT } from "./config";
import { initResponsiveScale } from "./scale";
import { Boot } from "./scenes/Boot";
import { Preload } from "./scenes/Preload";
import { Title } from "./scenes/Title";
import { CharacterCreate } from "./scenes/CharacterCreate";
import { Room } from "./scenes/Room";
import { UIOverlay } from "./scenes/UIOverlay";
import { initAutoSave } from "./cloud/save";

// No-ops outside a Vercel deployment (local dev, preview without the
// Analytics add-on) — safe to call unconditionally, same convention as
// initAutoSave() below.
inject();

initResponsiveScale();
// Safe to call unconditionally — every listener it wires up no-ops for
// guests and when Supabase isn't configured (see cloud/save.ts).
initAutoSave();

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game-stage",
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  pixelArt: true,
  backgroundColor: "#0a0a0f",
  scene: [Boot, Preload, Title, CharacterCreate, Room, UIOverlay],
});
