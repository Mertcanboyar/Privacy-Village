import { createServer } from "http";
import express from "express";
import cors from "cors";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { SceneRoom } from "./rooms/SceneRoom";

const port = Number(process.env.PORT ?? 2567);

// Comma-separated, e.g. "https://privacy-village.vercel.app,https://demo.privacyvillage.com"
// — see DEPLOY.md for how this gets set on Render.
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const app = express();
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define("scene", SceneRoom).filterBy(["sceneId"]);

httpServer.listen(port, () => {
  console.log(`Colyseus scene-presence server listening on port ${port} (allowed origins: ${allowedOrigins.join(", ")})`);
});
