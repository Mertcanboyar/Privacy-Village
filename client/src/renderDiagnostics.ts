import Phaser from "phaser";
import { logDecision } from "./cloud/save";

// Playtest Session 3, P0 — a tester's machine rendered every room except
// the village square as green stripes on black; the same build worked
// fine on the developer's. That's the signature of a WebGL texture
// upload silently failing on that GPU (an oversized texture past
// MAX_TEXTURE_SIZE, or a decode/network failure) with nothing in the
// game surfacing it. This module is the toolkit for diagnosing a class
// of failure like that on a machine we don't have access to: a running
// log of every load error (see recordLoadError(), fed by `loaderror`
// handlers in Preload.ts and Room.ts) and a `?debug=render` overlay
// (mountRenderDebugOverlay(), called once from main.ts regardless of
// how much of boot succeeds) that dumps renderer type, MAX_TEXTURE_SIZE,
// every currently-loaded texture's dimensions, and the error log itself.

export interface LoadErrorRecord {
  key: string;
  path: string;
  timestamp: number;
}

const loadErrors: LoadErrorRecord[] = [];

/** Called from every `loaderror` listener in the game (Preload.ts's
 * global load queue, Room.ts's per-room lazy bg/fg load) — the single
 * place that accumulates the error log the debug overlay and
 * render_failure reporting both read from. */
export function recordLoadError(key: string, path: string) {
  loadErrors.push({ key, path, timestamp: Date.now() });
  console.error(`[render] load error: ${key} (${path})`);
}

export function getLoadErrors(): LoadErrorRecord[] {
  return [...loadErrors];
}

export function isDebugRenderRequested(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("debug") === "render";
  } catch {
    return false;
  }
}

export interface RendererInfo {
  rendererType: "WebGL" | "Canvas" | "unknown";
  maxTextureSize: number | null;
  webglRendererString: string | null;
}

/** Reads the live renderer off a booted Phaser.Game — works whether
 * Phaser landed on WebGL or fell back to Canvas (Phaser.AUTO already
 * does that fallback automatically; this just reports which one it
 * picked, see main.ts). */
export function getRendererInfo(game: Phaser.Game): RendererInfo {
  const renderer = game.renderer;
  if (renderer instanceof Phaser.Renderer.WebGL.WebGLRenderer) {
    const gl = renderer.gl;
    let maxTextureSize: number | null = null;
    let webglRendererString: string | null = null;
    try {
      maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    } catch {
      maxTextureSize = null;
    }
    try {
      const dbgInfo = gl.getExtension("WEBGL_debug_renderer_info");
      webglRendererString = dbgInfo ? (gl.getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL) as string) : null;
    } catch {
      webglRendererString = null;
    }
    return { rendererType: "WebGL", maxTextureSize, webglRendererString };
  }
  if (renderer instanceof Phaser.Renderer.Canvas.CanvasRenderer) {
    return { rendererType: "Canvas", maxTextureSize: null, webglRendererString: null };
  }
  return { rendererType: "unknown", maxTextureSize: null, webglRendererString: null };
}

export interface LoadedTextureInfo {
  key: string;
  width: number;
  height: number;
}

/** Every texture currently resident in the game's TextureManager (global
 * across scenes) — includes room bg/fg, NPC spritesheets (reported as
 * their full strip size, not per-frame), UI textures, everything. */
export function getLoadedTextureKeys(game: Phaser.Game): LoadedTextureInfo[] {
  const out: LoadedTextureInfo[] = [];
  for (const key of game.textures.getTextureKeys()) {
    const tex = game.textures.get(key);
    const src = tex.source[0];
    if (src) out.push({ key, width: src.width, height: src.height });
  }
  return out.sort((a, b) => b.width - a.width);
}

export function getDeviceInfo(): { userAgent: string } {
  return { userAgent: navigator.userAgent };
}

/** Logs a "render_failure" decisions row (no-ops for guests, same as
 * every other logDecision() call site) with enough to diagnose a report
 * like the one that motivated this file without the tester's machine in
 * hand: the texture key that failed to draw, the full renderer/device
 * info, and the accumulated load-error log. */
export function logRenderFailure(game: Phaser.Game, textureKey: string) {
  const renderer = getRendererInfo(game);
  logDecision("render_failure", {
    textureKey,
    ...renderer,
    ...getDeviceInfo(),
    loadErrors: getLoadErrors(),
  });
}

let overlayMounted = false;

/** `?debug=render` — a plain DOM overlay (never depends on WebGL
 * actually working, unlike anything drawn via Phaser) reporting
 * renderer type, MAX_TEXTURE_SIZE, every loaded texture's dimensions
 * (flagging any that exceeds the reported cap), and the load-error log.
 * Call once, any time after the Phaser.Game exists — safe to call before
 * Preload finishes since it only reads what's there so far and refreshes
 * on an interval. */
export function mountRenderDebugOverlay(game: Phaser.Game) {
  if (overlayMounted || !isDebugRenderRequested()) return;
  overlayMounted = true;

  const el = document.createElement("pre");
  el.id = "render-debug-overlay";
  Object.assign(el.style, {
    position: "fixed",
    top: "0",
    left: "0",
    zIndex: "999999",
    margin: "0",
    padding: "12px",
    maxHeight: "100vh",
    maxWidth: "560px",
    overflow: "auto",
    background: "rgba(10, 10, 15, 0.92)",
    color: "#3ddc84",
    fontFamily: '"JetBrains Mono", monospace',
    fontSize: "11px",
    lineHeight: "1.4",
    whiteSpace: "pre-wrap",
    pointerEvents: "none",
    border: "1px solid #3d4257",
  });
  document.body.appendChild(el);

  function render() {
    const info = getRendererInfo(game);
    const textures = getLoadedTextureKeys(game);
    const errors = getLoadErrors();
    const cap = info.maxTextureSize;
    const lines: string[] = [];
    lines.push("=== ?debug=render ===");
    lines.push(`renderer: ${info.rendererType}`);
    lines.push(`MAX_TEXTURE_SIZE: ${cap ?? "n/a (Canvas renderer)"}`);
    lines.push(`GPU string: ${info.webglRendererString ?? "unavailable"}`);
    lines.push(`userAgent: ${navigator.userAgent}`);
    lines.push("");
    lines.push(`textures loaded (${textures.length}), largest first:`);
    for (const t of textures) {
      const overCap = cap !== null && (t.width > cap || t.height > cap);
      lines.push(`  ${overCap ? "⚠ " : "  "}${t.key}: ${t.width}x${t.height}${overCap ? "  EXCEEDS MAX_TEXTURE_SIZE" : ""}`);
    }
    lines.push("");
    lines.push(`load errors (${errors.length}):`);
    for (const e of errors) {
      lines.push(`  ${e.key}: ${e.path}`);
    }
    el.textContent = lines.join("\n");
  }

  render();
  window.setInterval(render, 2000);
}
