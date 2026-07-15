import Phaser from "phaser";

const STORAGE_PREFIX = "pv:debug:room:";

type Point = [number, number];

interface DebugRoomData {
  walkable?: Point[];
}

// Bridges the /debug room-authoring tool (see client/debug/main.ts) into
// any in-game scene: press L to overlay the walkable polygon for
// `roomName`. Prefers a live localStorage draft from /debug (so you can
// preview edits before committing them to assets/rooms/<room>.json);
// falls back to `committedWalkable` — the polygon actually driving
// movement in this scene — once a room JSON has been authored.
export function attachDebugOverlay(scene: Phaser.Scene, roomName: string, committedWalkable: Point[] = []) {
  const graphics = scene.add.graphics();
  graphics.setDepth(1000);
  graphics.setVisible(false);

  function redraw() {
    graphics.clear();

    let points: Point[] = [];
    const raw = localStorage.getItem(STORAGE_PREFIX + roomName);
    if (raw) {
      try {
        points = (JSON.parse(raw) as DebugRoomData).walkable ?? [];
      } catch {
        points = [];
      }
    }
    if (points.length === 0) points = committedWalkable;
    if (points.length === 0) return;

    graphics.fillStyle(0x50c878, 0.25);
    graphics.lineStyle(2, 0x50c878, 1);
    graphics.beginPath();
    points.forEach(([x, y], i) => (i === 0 ? graphics.moveTo(x, y) : graphics.lineTo(x, y)));
    graphics.closePath();
    graphics.fillPath();
    graphics.strokePath();
  }

  scene.input.keyboard?.on("keydown-L", () => {
    const next = !graphics.visible;
    graphics.setVisible(next);
    if (next) redraw();
  });
}
