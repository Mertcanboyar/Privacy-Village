// Frame layout of assets/sprites/rpg-urban-pack/Tilemap/tilemap.png
// 27 cols x 18 rows, 16px tiles, spacing 1, margin 0 (frame index = row * 27 + col).
// Each of the 6 characters occupies 4 columns (walk frames) x 3 rows
// (down, side, up — side is flipped horizontally for left/right).
const SHEET_COLS = 27;
const CHAR_COL_START = 23;
const FRAMES_PER_DIR = 4;

export type CharacterId = 0 | 1 | 2 | 3 | 4 | 5;

function frame(col: number, row: number) {
  return row * SHEET_COLS + col;
}

export function characterFrames(character: CharacterId) {
  const rowBase = character * 3;
  const cols = [0, 1, 2, 3].map((i) => CHAR_COL_START + i);
  return {
    down: cols.map((c) => frame(c, rowBase)),
    side: cols.map((c) => frame(c, rowBase + 1)),
    up: cols.map((c) => frame(c, rowBase + 2)),
  };
}

export const CHARACTER_COUNT = 6;
export const FRAMES_PER_DIRECTION = FRAMES_PER_DIR;
