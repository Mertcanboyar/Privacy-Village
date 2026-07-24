import Phaser from "phaser";

// "The Blueprint of the Post Road"'s Phase 1 — one condensed note per
// interview, appended as the player finds each source (see npc.ts's
// recordPostRoadNote()), shown in a small persistent panel (see
// ui/fieldNotesPanel.ts) that stays up through Phase 2-4 as the
// player's own documentation. Module-level EventEmitter singleton, same
// lifetime/style as questEngine.ts/academy.ts, kept separate from both
// since this is UI-facing text state neither of them needs to know about.
class FieldNotesStore extends Phaser.Events.EventEmitter {
  private notes: string[] = [];

  get all(): readonly string[] {
    return this.notes;
  }

  add(text: string) {
    this.notes.push(text);
    this.emit("changed");
  }
}

export const postRoadFieldNotes = new FieldNotesStore();
