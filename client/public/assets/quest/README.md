# Mission 1/2 evidence images — not yet supplied

Drop these 4 files in this folder with these exact names (referenced
directly by `client/src/missionBriefing.ts` and the two quest JSONs in
`client/public/data/quests/`):

- `village_map_mission1.jpeg` — the blueprint (defensive layout, gates,
  annotations). Opened from Mission 1's "VIEW THE BLUEPRINT" button.
- `dossier_sorcerer.jpeg` — "The Dark Sorcerer — Mage/Ranged"
- `dossier_goblin.jpeg` — "The Goblin Saboteur — Rogue/Infiltrator"
- `dossier_berserker.jpeg` — "Ironhorn Berserker — Tank/Brute Force".
  Built against this filename, not the label — an earlier export of
  this image said "Uruk-Hai Berserker"; if you're placing that older
  file here, rename it to `dossier_berserker.jpeg` regardless of what
  the artwork itself still says.

Until these exist, the full-screen evidence overlay
(`client/src/ui/imageOverlay.ts`) shows an "EVIDENCE PENDING" fallback
card instead of erroring — the rest of Mission 1/2 (mission text,
choices, points, clearance) is unaffected either way.
