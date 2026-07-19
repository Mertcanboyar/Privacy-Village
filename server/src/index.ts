import { createServer } from "http";
import express from "express";
import cors from "cors";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { SceneRoom } from "./rooms/SceneRoom";

const port = Number(process.env.PORT ?? 2567);

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define("scene", SceneRoom).filterBy(["sceneId"]);

httpServer.listen(port, () => {
  console.log(`Colyseus scene-presence server listening on ws://localhost:${port}`);
});
