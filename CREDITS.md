# Asset credits

Placeholder assets chosen Day 1 to unblock building (see [PLAN.md](PLAN.md)).
All CC0 — no attribution required, credit given anyway. Swap for paid
tilesets/sprites later without blocking progress.

## Room backgrounds — Village, Tavern, Courthouse

Painted background art for the 3 rooms (see [CLAUDE.md](CLAUDE.md) for the
painted-scene architecture). Replaces the Kenney Roguelike/RPG tileset used
by the Week 1 tilemap prototype, which is now retired.
Location: `client/public/assets/rooms/{village,tavern,courthouse}_bg.png`

## Player avatar

"Female Wizard" painted character (single static pose, flipped
horizontally for left/right facing). Source/license not confirmed — came
with `.ai`/`.psd` source files suggesting a marketplace or commissioned
asset, not CC0. **Verify licensing before any public release.**
Location: `client/public/assets/sprites/player/wizard.png`

"Archer" (Elf), "Paladin" (Knight_03), "Viking" (Viking Leader) — three
more CraftPix.net character packs, same treatment as the Herald's Dark
Oracle sprite (single idle frame, cropped to its opaque bounds). License
per https://craftpix.net/file-licenses/, not CC0 — **verify licensing
before any public release.**
Location: `client/public/assets/sprites/player/{archer,paladin,viking}.png`

## Static NPCs

"Female Knight" — same cutout-puppet style/source as the player wizard,
single static pose. Originally also used for the ambient "Villager"
wanderer and the `villager_a`/`villager_b` Q3 witnesses; both were
removed per feedback, so this is now only the avatar-picker's Knight
option. Source/license not confirmed, same caveat as the wizard above.
Location: `client/public/assets/sprites/npc/knight.png`

"Dark Oracle" — CraftPix.net character pack (single idle frame used,
cropped to its opaque bounds). Used for the Herald NPC. License per
https://craftpix.net/file-licenses/, not CC0 — **verify licensing before
any public release.** Location: `client/public/assets/sprites/npc/herald.png`

## Lore NPCs (Bram, Odile, Quill, Sabine, Fennick, Patron)

Six more CraftPix.net character packs (Artist, Astrologer, Citizen,
Forest Ranger ×3 recolors), one per lore NPC — replaces the original
"Village NPC Vol.1" pack. Each sprite sheet is a self-built 4-frame idle
strip: the pack's first 4 "Idle" sequence frames, cropped to their
shared union bounding box (so the loop doesn't jitter) and laid out
left-to-right. License per https://craftpix.net/file-licenses/, not
CC0 — **verify licensing before any public release.** Mapping (a
curatorial choice, not a hard requirement — swap freely): Bram→Citizen,
Odile→Forest Ranger 3, Quill→Artist, Sabine→Forest Ranger 2,
Fennick→Astrologer (hooded/mystical, fits the "oracle" merchant),
Patron→Forest Ranger 1. No sprite exists yet for "The Cat" (see PLAN.md
Phase 2, Day 2) — that NPC is deferred until a matching asset is sourced.
Location: `client/public/assets/sprites/npc-pack/{bram,odile,quill,sabine,fennick,patron}.png`

## Character sprites — unused (Kenney, kept for possible future NPCs)

**RPG Urban Pack** by Kenney (kenney.nl). 16×16 grid, 6 characters with
walking animation frames. License: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
Source: https://kenney.nl/assets/rpg-urban-pack
Location: `client/public/assets/sprites/rpg-urban-pack/`

## Still needed

- Foreground occlusion PNGs per room (`{room}_fg.png`)
- NPC spawns in room JSON (author via `/debug`, see [CLAUDE.md](CLAUDE.md))
- UI pack (dialogue box, buttons, badge/medal icons)
- Audio (ambient loop, footsteps, quest chime, badge fanfare)
- Ambient animation sprites (fountain, torch, birds, chimney smoke)
