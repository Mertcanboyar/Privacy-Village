import Phaser from "phaser";
import { GAME_HEIGHT } from "../config";
import { AVATAR_OPTIONS, factionColorFor } from "../session";
import type { RemotePlayerSnapshot } from "./NetClient";

// Remote players render through the SAME single-Image system the local
// player and wanderers already use (see Room.ts) — this project has no
// Sprite/animation frames or contact-shadow system for any character, so
// the task spec's literal "walk/idle anims, contact shadow" ask isn't
// something to build; a moving remote player already reads as moving via
// its interpolated position, matching how wanderers work today.
const SCALE_FAR = 0.75;
const SCALE_NEAR = 1.0;
const LERP_FACTOR = 0.12;
const SNAP_DISTANCE = 150;
// Exported so Room.ts can render the local player's own bubble with
// matching styling/lifetime — this file already owns the remote-side
// half of the same feature (see showBubble() below), no reason for a
// third copy of these constants to exist.
export const CHAT_BUBBLE_DURATION_MS = 5000;
export const CHAT_BUBBLE_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: '"JetBrains Mono", monospace',
  fontSize: "13px",
  color: "#ffffff",
  backgroundColor: "rgba(20, 22, 31, 0.85)",
  padding: { x: 8, y: 4 },
  wordWrap: { width: 220 },
  align: "center",
};
// §2 "The Gathering" stage mechanic — a message sent while standing in
// the Tavern's stage zone (see Room.ts's isOnStage()) renders bigger
// and gold, visible the same scene-wide way every chat message already
// is (no separate distribution/permission system — see PLAN.md). Same
// shape as CHAT_BUBBLE_STYLE otherwise, reused by both the local
// player's own bubble (Room.ts) and remote ones (showBubble() below).
export const STAGE_CHAT_BUBBLE_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: '"JetBrains Mono", monospace',
  fontSize: "18px",
  fontStyle: "bold",
  color: "#f0b429",
  backgroundColor: "rgba(20, 22, 31, 0.9)",
  padding: { x: 10, y: 6 },
  wordWrap: { width: 260 },
  align: "center",
};
export const EMOTE_BUBBLE_DURATION_MS = 2000;
export const EMOTE_ICONS: Record<string, string> = {
  wave: "\u{1F44B}",
  question: "❓",
  agree: "✅",
  celebrate: "\u{1F389}",
};

// §3 "Visible Identity" — role badge shown above the title/name stack
// (see the vertical-stack repositioning in update() below). Exported so
// Room.ts can render the local player's own badge with matching
// styling, same "one copy, two consumers" pattern as CHAT_BUBBLE_STYLE.
export const ROLE_BADGES: Record<string, { label: string; color: string }> = {
  speaker: { label: "\u{1F3A9} SPEAKER", color: "#f0b429" },
  host: { label: "HOST", color: "#93c5fd" },
  founding: { label: "FOUNDING VILLAGER", color: "#c4b5fd" },
};

function depthScaleFor(y: number): number {
  const t = Phaser.Math.Clamp(y / GAME_HEIGHT, 0, 1);
  return SCALE_FAR + (SCALE_NEAR - SCALE_FAR) * t;
}

function textureFor(spriteId: string): { texture: string; baseScale: number } {
  const avatar = AVATAR_OPTIONS.find((a) => a.id === spriteId) ?? AVATAR_OPTIONS[0];
  return { texture: avatar.texture, baseScale: avatar.baseScale };
}

interface RemoteSprite {
  image: Phaser.GameObjects.Image;
  name: string;
  nameTag: Phaser.GameObjects.Text;
  // Public Agent Dossier title (see dossier.ts) — always created, just
  // left empty/invisible when the player has none active, so toggling a
  // title on/off mid-session is a text/visibility update rather than a
  // create/destroy (see applySnapshot() and update() below).
  titleTag: Phaser.GameObjects.Text;
  // §3 "Visible Identity" — same always-created/toggle-visibility shape
  // as titleTag above, sitting one slot further up the stack.
  roleTag: Phaser.GameObjects.Text;
  baseScale: number;
  targetX: number;
  targetY: number;
  facing: string;
  chatBubble: Phaser.GameObjects.Text | null;
  chatBubbleExpiresAt: number;
  emoteBubble: Phaser.GameObjects.Text | null;
  emoteBubbleExpiresAt: number;
}

// Scene-scoped by design: instantiated fresh in Room.create() (same
// lifecycle as NPCController/QuestController), so a scene.restart() on a
// door transition tears every remote sprite down for free via normal
// Phaser scene teardown — no manual cleanup call needed on disconnect.
export class RemotePlayerController {
  private scene: Phaser.Scene;
  private sprites = new Map<string, RemoteSprite>();

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  spawn(snapshot: RemotePlayerSnapshot) {
    if (this.sprites.has(snapshot.sessionId)) {
      this.applySnapshot(snapshot);
      return;
    }

    const { texture, baseScale } = textureFor(snapshot.spriteId);
    const image = this.scene.add.image(snapshot.x, snapshot.y, texture).setOrigin(0.5, 1);
    image.setScale(baseScale * depthScaleFor(snapshot.y));
    image.setDepth(snapshot.y);
    if (snapshot.facing === "left") image.setFlipX(true);
    else if (snapshot.facing === "right") image.setFlipX(false);

    const nameTag = this.scene.add
      .text(snapshot.x, snapshot.y - image.displayHeight - 4, snapshot.name.toUpperCase(), {
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: "14px",
        color: factionColorFor(snapshot.faction),
        stroke: "#000000",
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1)
      .setDepth(100000);

    // Sits between the name tag and the character's head — see the
    // update()'s repositioning below for how the two share that space.
    const titleTag = this.scene.add
      .text(snapshot.x, snapshot.y - image.displayHeight - 4, snapshot.activeTitle, {
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: "10px",
        color: factionColorFor(snapshot.faction),
        stroke: "#000000",
        strokeThickness: 2,
      })
      .setOrigin(0.5, 1)
      .setDepth(100000)
      .setVisible(!!snapshot.activeTitle);

    const roleBadge = ROLE_BADGES[snapshot.role];
    const roleTag = this.scene.add
      .text(snapshot.x, snapshot.y - image.displayHeight - 4, roleBadge?.label ?? "", {
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: "11px",
        fontStyle: "bold",
        color: roleBadge?.color ?? "#ffffff",
        stroke: "#000000",
        strokeThickness: 2,
      })
      .setOrigin(0.5, 1)
      .setDepth(100000)
      .setVisible(!!roleBadge);

    this.sprites.set(snapshot.sessionId, {
      image,
      name: snapshot.name,
      nameTag,
      titleTag,
      roleTag,
      baseScale,
      targetX: snapshot.x,
      targetY: snapshot.y,
      facing: snapshot.facing,
      chatBubble: null,
      chatBubbleExpiresAt: 0,
      emoteBubble: null,
      emoteBubbleExpiresAt: 0,
    });
  }

  applySnapshot(snapshot: RemotePlayerSnapshot) {
    const remote = this.sprites.get(snapshot.sessionId);
    if (!remote) {
      this.spawn(snapshot);
      return;
    }
    remote.targetX = snapshot.x;
    remote.targetY = snapshot.y;
    remote.facing = snapshot.facing;
    remote.name = snapshot.name;
    remote.titleTag.setText(snapshot.activeTitle).setVisible(!!snapshot.activeTitle);
    const roleBadge = ROLE_BADGES[snapshot.role];
    remote.roleTag
      .setText(roleBadge?.label ?? "")
      .setColor(roleBadge?.color ?? "#ffffff")
      .setVisible(!!roleBadge);
  }

  /** Display name for a still-present remote sprite, e.g. for the chat
   * log (see chatLog.ts) which only gets a sessionId off the wire.
   * `undefined` if they've already left. */
  getName(sessionId: string): string | undefined {
    return this.sprites.get(sessionId)?.name;
  }

  /** §4 "Contact Exchange" — nearest remote sprite within `radius` of
   * (x, y), or null if none. Room.ts polls this every frame (same shape
   * as npc.ts's own proximity+[E] loop) to show the exchange prompt. */
  findNearby(x: number, y: number, radius: number): { sessionId: string; name: string } | null {
    let closest: { sessionId: string; name: string } | null = null;
    let closestDist = radius;
    for (const [sessionId, remote] of this.sprites) {
      const dist = Phaser.Math.Distance.Between(x, y, remote.image.x, remote.image.y);
      if (dist < closestDist) {
        closestDist = dist;
        closest = { sessionId, name: remote.name };
      }
    }
    return closest;
  }

  /** A "chat" broadcast arriving for a sessionId this room doesn't (or
   * no longer) have a sprite for — e.g. it left mid-flight — is dropped
   * silently, same "presence is garnish" tolerance as everything else
   * in this file. `stage` (see PLAN.md's Gathering) swaps in the
   * bigger/gold style — same bubble mechanism otherwise. */
  showBubble(sessionId: string, text: string, stage = false) {
    const remote = this.sprites.get(sessionId);
    if (!remote) return;
    remote.chatBubble?.destroy();
    remote.chatBubble = this.scene.add
      .text(remote.image.x, remote.image.y - remote.image.displayHeight - 24, text, stage ? STAGE_CHAT_BUBBLE_STYLE : CHAT_BUBBLE_STYLE)
      .setOrigin(0.5, 1)
      .setDepth(100001);
    remote.chatBubbleExpiresAt = this.scene.time.now + CHAT_BUBBLE_DURATION_MS;
  }

  /** Hotkey emote (see Room.ts) — a short-lived emoji bubble, separate
   * slot from the chat bubble so an emote never cuts off an in-progress
   * chat message (or vice versa) landing at the same moment. */
  emote(sessionId: string, emoteId: string) {
    const remote = this.sprites.get(sessionId);
    const icon = EMOTE_ICONS[emoteId];
    if (!remote || !icon) return;
    remote.emoteBubble?.destroy();
    remote.emoteBubble = this.scene.add
      .text(remote.image.x, remote.image.y - remote.image.displayHeight - 24, icon, { fontSize: "28px" })
      .setOrigin(0.5, 1)
      .setDepth(100001);
    remote.emoteBubbleExpiresAt = this.scene.time.now + EMOTE_BUBBLE_DURATION_MS;
  }

  remove(sessionId: string) {
    const remote = this.sprites.get(sessionId);
    if (!remote) return;
    remote.image.destroy();
    remote.nameTag.destroy();
    remote.titleTag.destroy();
    remote.roleTag.destroy();
    remote.chatBubble?.destroy();
    remote.emoteBubble?.destroy();
    this.sprites.delete(sessionId);
  }

  update() {
    for (const remote of this.sprites.values()) {
      const dx = remote.targetX - remote.image.x;
      const dy = remote.targetY - remote.image.y;
      const dist = Math.hypot(dx, dy);

      if (dist > SNAP_DISTANCE) {
        remote.image.setPosition(remote.targetX, remote.targetY);
      } else if (dist > 0.5) {
        remote.image.x += dx * LERP_FACTOR;
        remote.image.y += dy * LERP_FACTOR;
      }

      if (remote.facing === "left") remote.image.setFlipX(true);
      else if (remote.facing === "right") remote.image.setFlipX(false);

      remote.image.setScale(remote.baseScale * depthScaleFor(remote.image.y));
      remote.image.setDepth(remote.image.y);

      // Stack bottom-to-top: name (always) → title (if any) → role badge
      // (if any), each occupying the next slot up only when the one
      // below it is actually visible — same "no title = no gap" rule
      // extended one level further for the role badge.
      const headY = remote.image.y - remote.image.displayHeight - 4;
      remote.nameTag.setPosition(remote.image.x, headY);
      let nextY = headY;
      if (remote.titleTag.visible) {
        nextY -= remote.nameTag.displayHeight + 2;
        remote.titleTag.setPosition(remote.image.x, nextY);
      }
      if (remote.roleTag.visible) {
        nextY -= (remote.titleTag.visible ? remote.titleTag.displayHeight : remote.nameTag.displayHeight) + 2;
        remote.roleTag.setPosition(remote.image.x, nextY);
      }

      if (remote.chatBubble) {
        if (this.scene.time.now > remote.chatBubbleExpiresAt) {
          remote.chatBubble.destroy();
          remote.chatBubble = null;
        } else {
          remote.chatBubble.setPosition(remote.image.x, remote.image.y - remote.image.displayHeight - 24);
        }
      }

      if (remote.emoteBubble) {
        if (this.scene.time.now > remote.emoteBubbleExpiresAt) {
          remote.emoteBubble.destroy();
          remote.emoteBubble = null;
        } else {
          remote.emoteBubble.setPosition(remote.image.x, remote.image.y - remote.image.displayHeight - 24);
        }
      }
    }
  }
}
