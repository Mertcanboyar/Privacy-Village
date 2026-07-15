import { Room, Client } from "colyseus";
import { Schema, type, MapSchema, ArraySchema } from "@colyseus/schema";

export class Player extends Schema {
  @type("string") name = "";
  @type("string") spriteId = "hero_1";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("string") direction = "down";
  @type(["string"]) badges = new ArraySchema<string>();
}

export class VillageState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
}

interface JoinOptions {
  name: string;
  spriteId: string;
}

export class VillageRoom extends Room<VillageState> {
  maxClients = 30;

  onCreate() {
    this.setState(new VillageState());

    this.onMessage("move", (client, message: { x: number; y: number; direction: string }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      player.x = message.x;
      player.y = message.y;
      player.direction = message.direction;
    });

    this.onMessage("badge", (client, message: { badgeId: string }) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.badges.includes(message.badgeId)) return;
      player.badges.push(message.badgeId);
    });
  }

  onJoin(client: Client, options: JoinOptions) {
    const player = new Player();
    player.name = options.name ?? "Traveler";
    player.spriteId = options.spriteId ?? "hero_1";
    this.state.players.set(client.sessionId, player);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
  }
}
