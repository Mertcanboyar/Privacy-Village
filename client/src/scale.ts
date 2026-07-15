import { GAME_WIDTH, GAME_HEIGHT } from "./config";

// Scales #game-stage (fixed 1280x720 box, see style.css) up or down to
// fill the available window while preserving aspect ratio — a CSS
// transform, not a layout change, so the game and #ui-root's dozens of
// hardcoded-px UI elements stay in the same 1280x720 coordinate space
// and need no changes. #app's flex-centering keeps the box centered;
// scaling around the default center origin keeps it centered too.
export function initResponsiveScale() {
  const stage = document.getElementById("game-stage")!;

  function applyScale() {
    const scale = Math.min(window.innerWidth / GAME_WIDTH, window.innerHeight / GAME_HEIGHT);
    stage.style.transform = `scale(${scale})`;
  }

  applyScale();
  window.addEventListener("resize", applyScale);
}
