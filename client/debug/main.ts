// Tiny authoring tool for room JSON (see CLAUDE.md's painted-scene architecture).
// Not part of the shipped demo — dev-only, not included in the production build.

type Point = [number, number];

interface Door {
  x: number;
  y: number;
  width: number;
  height: number;
  target: string;
}

interface Light {
  x: number;
  y: number;
  radius: number;
}

interface RoomData {
  room: string;
  background: string;
  foreground: string;
  walkable: Point[];
  doors: Door[];
  lights: Light[];
  npcSpawns: unknown[];
}

const ROOMS = ["village", "tavern", "courthouse"] as const;
type RoomName = (typeof ROOMS)[number];

const storageKey = (room: string) => `pv:debug:room:${room}`;

function emptyRoom(room: RoomName): RoomData {
  return {
    room,
    background: `${room}_bg.png`,
    foreground: `${room}_fg.png`,
    walkable: [],
    doors: [],
    lights: [],
    npcSpawns: [],
  };
}

function loadRoom(room: RoomName): RoomData {
  const raw = localStorage.getItem(storageKey(room));
  if (!raw) return emptyRoom(room);
  try {
    return { ...emptyRoom(room), ...JSON.parse(raw) };
  } catch {
    return emptyRoom(room);
  }
}

function saveRoom(data: RoomData) {
  localStorage.setItem(storageKey(data.room), JSON.stringify(data));
}

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const roomSelect = document.getElementById("roomSelect") as HTMLSelectElement;
const bgStatus = document.getElementById("bgStatus") as HTMLDivElement;
const walkableCount = document.getElementById("walkableCount") as HTMLSpanElement;
const doorList = document.getElementById("doorList") as HTMLDivElement;
const lightList = document.getElementById("lightList") as HTMLDivElement;
const output = document.getElementById("output") as HTMLTextAreaElement;
const undoPointBtn = document.getElementById("undoPoint") as HTMLButtonElement;
const clearPolygonBtn = document.getElementById("clearPolygon") as HTMLButtonElement;
const copyJsonBtn = document.getElementById("copyJson") as HTMLButtonElement;
const modeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".modeBtn"));

let mode: "walkable" | "doors" | "lights" = "walkable";
let room: RoomData = loadRoom("village");
let bgImage: HTMLImageElement | null = null;

let dragStart: Point | null = null;
let dragCurrent: Point | null = null;

function canvasPoint(evt: MouseEvent): Point {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return [Math.round((evt.clientX - rect.left) * scaleX), Math.round((evt.clientY - rect.top) * scaleY)];
}

function loadBackground(name: RoomName) {
  const img = new Image();
  img.onload = () => {
    bgImage = img;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    bgStatus.textContent = `background loaded (${img.naturalWidth}x${img.naturalHeight})`;
    render();
  };
  img.onerror = () => {
    bgImage = null;
    canvas.width = 1280;
    canvas.height = 720;
    bgStatus.textContent = `no background found at assets/rooms/${name}_bg.png — painting on a blank 1280x720 canvas`;
    render();
  };
  img.src = `/assets/rooms/${name}_bg.png`;
}

function render() {
  if (bgImage) {
    ctx.drawImage(bgImage, 0, 0);
  } else {
    ctx.fillStyle = "#3a4a3a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // walkable polygon
  if (room.walkable.length > 0) {
    ctx.beginPath();
    room.walkable.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    if (room.walkable.length > 2) ctx.closePath();
    ctx.fillStyle = "rgba(80, 200, 120, 0.25)";
    ctx.fill();
    ctx.strokeStyle = "#50c878";
    ctx.lineWidth = 2;
    ctx.stroke();
    room.walkable.forEach(([x, y], i) => {
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#50c878";
      ctx.fill();
      ctx.fillStyle = "#0e0e12";
      ctx.font = "10px monospace";
      ctx.fillText(String(i), x + 6, y - 6);
    });
  }

  // doors
  for (const door of room.doors) {
    ctx.strokeStyle = "#5fa8ff";
    ctx.lineWidth = 2;
    ctx.strokeRect(door.x, door.y, door.width, door.height);
    ctx.fillStyle = "rgba(95, 168, 255, 0.2)";
    ctx.fillRect(door.x, door.y, door.width, door.height);
    ctx.fillStyle = "#5fa8ff";
    ctx.font = "11px monospace";
    ctx.fillText(`→ ${door.target}`, door.x + 4, door.y + 14);
  }

  // lights
  for (const light of room.lights) {
    ctx.beginPath();
    ctx.arc(light.x, light.y, light.radius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 220, 100, 0.15)";
    ctx.fill();
    ctx.strokeStyle = "#ffdc64";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(light.x, light.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = "#ffdc64";
    ctx.fill();
  }

  // active drag preview
  if (dragStart && dragCurrent) {
    if (mode === "doors") {
      const x = Math.min(dragStart[0], dragCurrent[0]);
      const y = Math.min(dragStart[1], dragCurrent[1]);
      const w = Math.abs(dragCurrent[0] - dragStart[0]);
      const h = Math.abs(dragCurrent[1] - dragStart[1]);
      ctx.strokeStyle = "#5fa8ff";
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
    } else if (mode === "lights") {
      const radius = Math.hypot(dragCurrent[0] - dragStart[0], dragCurrent[1] - dragStart[1]);
      ctx.beginPath();
      ctx.arc(dragStart[0], dragStart[1], radius, 0, Math.PI * 2);
      ctx.strokeStyle = "#ffdc64";
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

function renderLists() {
  walkableCount.textContent = String(room.walkable.length);

  doorList.innerHTML = "";
  room.doors.forEach((door, i) => {
    const row = document.createElement("div");
    row.className = "listItem";
    row.innerHTML = `<span>${Math.round(door.x)},${Math.round(door.y)} ${Math.round(door.width)}x${Math.round(door.height)} → ${door.target}</span>`;
    const del = document.createElement("button");
    del.textContent = "×";
    del.onclick = () => {
      room.doors.splice(i, 1);
      commit();
    };
    row.appendChild(del);
    doorList.appendChild(row);
  });

  lightList.innerHTML = "";
  room.lights.forEach((light, i) => {
    const row = document.createElement("div");
    row.className = "listItem";
    row.innerHTML = `<span>${Math.round(light.x)},${Math.round(light.y)} r${Math.round(light.radius)}</span>`;
    const del = document.createElement("button");
    del.textContent = "×";
    del.onclick = () => {
      room.lights.splice(i, 1);
      commit();
    };
    row.appendChild(del);
    lightList.appendChild(row);
  });
}

function commit() {
  saveRoom(room);
  render();
  renderLists();
  output.value = JSON.stringify(room, null, 2);
}

roomSelect.addEventListener("change", () => {
  const next = roomSelect.value as RoomName;
  room = loadRoom(next);
  dragStart = null;
  dragCurrent = null;
  loadBackground(next);
  commit();
});

modeButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    mode = btn.dataset.mode as typeof mode;
    modeButtons.forEach((b) => b.classList.toggle("active", b === btn));
  });
});

canvas.addEventListener("click", (evt) => {
  if (mode !== "walkable") return;
  room.walkable.push(canvasPoint(evt));
  commit();
});

canvas.addEventListener("mousedown", (evt) => {
  if (mode === "walkable") return;
  dragStart = canvasPoint(evt);
  dragCurrent = dragStart;
});

canvas.addEventListener("mousemove", (evt) => {
  if (!dragStart) return;
  dragCurrent = canvasPoint(evt);
  render();
});

window.addEventListener("mouseup", () => {
  if (!dragStart || !dragCurrent) return;

  if (mode === "doors") {
    const x = Math.min(dragStart[0], dragCurrent[0]);
    const y = Math.min(dragStart[1], dragCurrent[1]);
    const width = Math.abs(dragCurrent[0] - dragStart[0]);
    const height = Math.abs(dragCurrent[1] - dragStart[1]);
    if (width > 2 && height > 2) {
      const target = window.prompt("Target room (village/tavern/courthouse):", "village") || "village";
      room.doors.push({ x, y, width, height, target });
    }
  } else if (mode === "lights") {
    const radius = Math.hypot(dragCurrent[0] - dragStart[0], dragCurrent[1] - dragStart[1]);
    if (radius > 2) {
      room.lights.push({ x: dragStart[0], y: dragStart[1], radius });
    }
  }

  dragStart = null;
  dragCurrent = null;
  commit();
});

undoPointBtn.addEventListener("click", () => {
  room.walkable.pop();
  commit();
});

clearPolygonBtn.addEventListener("click", () => {
  room.walkable = [];
  commit();
});

copyJsonBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(output.value);
  copyJsonBtn.textContent = "Copied!";
  setTimeout(() => (copyJsonBtn.textContent = "Copy to clipboard"), 1000);
});

loadBackground("village");
commit();
