import { createServer } from "http";
import express from "express";
import cors from "cors";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { VillageRoom } from "./rooms/VillageRoom";

const port = Number(process.env.PORT ?? 2567);

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define("village", VillageRoom);

httpServer.listen(port, () => {
  console.log(`Colyseus village server listening on ws://localhost:${port}`);
});
