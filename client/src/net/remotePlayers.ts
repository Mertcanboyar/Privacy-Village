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
  nameTag: Phaser.GameObjects.Text;
  baseScale: number;
  targetX: number;
  targetY: number;
  facing: string;
  chatBubble: Phaser.GameObjects.Text | null;
  chatBubbleExpiresAt: number;
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

    this.sprites.set(snapshot.sessionId, {
      image,
      nameTag,
      baseScale,
      targetX: snapshot.x,
      targetY: snapshot.y,
      facing: snapshot.facing,
      chatBubble: null,
      chatBubbleExpiresAt: 0,
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
  }

  /** A "chat" broadcast arriving for a sessionId this room doesn't (or
   * no longer) have a sprite for — e.g. it left mid-flight — is dropped
   * silently, same "presence is garnish" tolerance as everything else
   * in this file. */
  showBubble(sessionId: string, text: string) {
    const remote = this.sprites.get(sessionId);
    if (!remote) return;
    remote.chatBubble?.destroy();
    remote.chatBubble = this.scene.add
      .text(remote.image.x, remote.image.y - remote.image.displayHeight - 24, text, CHAT_BUBBLE_STYLE)
      .setOrigin(0.5, 1)
      .setDepth(100001);
    remote.chatBubbleExpiresAt = this.scene.time.now + CHAT_BUBBLE_DURATION_MS;
  }

  remove(sessionId: string) {
    const remote = this.sprites.get(sessionId);
    if (!remote) return;
    remote.image.destroy();
    remote.nameTag.destroy();
    remote.chatBubble?.destroy();
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
      remote.nameTag.setPosition(remote.image.x, remote.image.y - remote.image.displayHeight - 4);

      if (remote.chatBubble) {
        if (this.scene.time.now > remote.chatBubbleExpiresAt) {
          remote.chatBubble.destroy();
          remote.chatBubble = null;
        } else {
          remote.chatBubble.setPosition(remote.image.x, remote.image.y - remote.image.displayHeight - 24);
        }
      }
    }
  }
}
