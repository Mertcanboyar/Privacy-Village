import Phaser from "phaser";
import { duckAudio } from "./audio";

// Framework-free module singleton for the Events panel, same style as
// academy.ts/questEngine.ts/session.ts — a plain class extending
// Phaser.Events.EventEmitter so the Scene-bound DOM UI (eventsOverlay.ts)
// can react without this module depending on any Scene. Room.ts checks
// `events.isOpen` directly to lock player movement, same as academy.isOpen.

export interface EventVideo {
  id: string;
  title: string;
  description: string;
  meta: string;
  thumbnail: string;
}

class EventsManager extends Phaser.Events.EventEmitter {
  private open_ = false;
  private videos: EventVideo[] = [];

  get isOpen(): boolean {
    return this.open_;
  }

  loadData(videos: EventVideo[]) {
    this.videos = videos;
  }

  getVideos(): EventVideo[] {
    return this.videos;
  }

  open() {
    if (this.open_) return;
    this.open_ = true;
    duckAudio(true);
    this.emit("opened");
  }

  close() {
    if (!this.open_) return;
    this.open_ = false;
    duckAudio(false);
    this.emit("closed");
  }

  toggle() {
    if (this.open_) this.close();
    else this.open();
  }
}

export const events = new EventsManager();
