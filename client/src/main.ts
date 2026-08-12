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
import { initDossierHooks } from "./dossier";
import { mountRenderDebugOverlay, getRendererInfo } from "./renderDiagnostics";

// No-ops outside a Vercel deployment (local dev, preview without the
// Analytics add-on) — safe to call unconditionally, same convention as
// initAutoSave() below.
inject();

initResponsiveScale();
// Safe to call unconditionally — every listener it wires up no-ops for
// guests and when Supabase isn't configured (see cloud/save.ts).
initAutoSave();
// Concept/title unlock checks on quest/module completion (see
// dossier.ts) — safe unconditionally, same as initAutoSave() above;
// works for guests too, since unlocks are local state independent of
// persistence.
initDossierHooks();

// Phaser.AUTO already tries WebGL first and falls back to Canvas on its
// own if WebGL is unavailable — this doesn't add a fallback mechanism,
// it just makes which path got picked observable (see Playtest Session
// 3, P0 — a rendering failure on a remote tester's machine with nothing
// logged is what this whole file's diagnostics exist to prevent).
const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game-stage",
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  pixelArt: true,
  backgroundColor: "#0a0a0f",
  scene: [Boot, Preload, Title, CharacterCreate, Room, UIOverlay],
});

game.events.once(Phaser.Core.Events.READY, () => {
  const info = getRendererInfo(game);
  if (info.rendererType === "Canvas") {
    console.warn("[render] WebGL unavailable — Phaser fell back to the Canvas renderer.", info);
  } else {
    console.log(`[render] renderer: ${info.rendererType}, MAX_TEXTURE_SIZE: ${info.maxTextureSize}`);
  }
});

// `?debug=render` — see renderDiagnostics.ts. Mounted here (not from a
// Scene) so it works even if boot never gets far enough to reach one.
mountRenderDebugOverlay(game);
