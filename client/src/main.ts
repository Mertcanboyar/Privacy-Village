import Phaser from "phaser";
import "./style.css";
import { GAME_WIDTH, GAME_HEIGHT } from "./config";
import { Boot } from "./scenes/Boot";
import { Preload } from "./scenes/Preload";
import { Title } from "./scenes/Title";
import { CharacterCreate } from "./scenes/CharacterCreate";
import { Room } from "./scenes/Room";
import { UIOverlay } from "./scenes/UIOverlay";

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game-stage",
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  pixelArt: true,
  backgroundColor: "#0a0a0f",
  scene: [Boot, Preload, Title, CharacterCreate, Room, UIOverlay],
});
