import { Room as LKRoom } from "livekit-client";
import { el } from "./ui/dom";
import { voice } from "./voice";

// Spatial voice chat's device picker + mic level test + master volume
// slider (see PLAN — Spatial Voice Chat, §6 UI) — opened from hud.ts's
// MENU dropdown via a "🎙️ VOICE SETTINGS" item, same .panel.ds-root
// floating-panel convention the MENU dropdown itself already uses.
// Constructed once (alongside HUDController, in the persistent
// UIOverlay scene) since this is session-scoped UI, not per-room state
// — same reasoning voice.ts's own module-singleton doc comment gives.

export class VoiceSettingsPanel {
  private panelEl: HTMLElement;
  private open_ = false;

  private deviceSelectEl: HTMLSelectElement;
  private levelMeterFillEl: HTMLElement;
  private levelMeterMessageEl: HTMLElement;
  private volumeValueEl: HTMLElement;

  private analyserSource: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private meterRafId: number | null = null;

  constructor(root: HTMLElement) {
    this.deviceSelectEl = el("select", {
      style: {
        width: "100%",
        fontFamily: "var(--font-mono)",
        fontSize: "12px",
        padding: "8px",
        borderRadius: "var(--radius-sm)",
        border: "2px solid var(--border-strong)",
        background: "var(--bg-raised)",
        color: "var(--text-primary)",
      },
      on: { change: (e) => void voice.setInputDevice((e.target as HTMLSelectElement).value) },
    });

    this.levelMeterFillEl = el("div", {
      style: { height: "100%", width: "0%", background: "var(--accent-green)", transition: "width 60ms linear" },
    });
    this.levelMeterMessageEl = el("div", {
      text: "Grant mic access via V or M first to test it here.",
      style: { fontFamily: "var(--font-body)", fontSize: "12px", color: "var(--text-muted)", display: "none" },
    });

    this.volumeValueEl = el("span", { text: "100%", style: { fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-muted)" } });
    const volumeSliderEl = el("input", {
      attrs: { type: "range", min: "0", max: "100", value: "100" },
      style: { width: "100%" },
      on: {
        input: (e) => {
          const pct = Number((e.target as HTMLInputElement).value);
          voice.setOutputVolume(pct / 100);
          this.volumeValueEl.textContent = `${pct}%`;
        },
      },
    });

    const closeBtnEl = el("button", {
      className: "btn btn--ghost",
      text: "✕ CLOSE",
      style: { fontSize: "11px", padding: "8px 12px", alignSelf: "flex-end" },
      on: { click: () => this.close() },
    });

    this.panelEl = el(
      "div",
      {
        className: "panel ds-root",
        style: {
          position: "absolute",
          top: "130px",
          left: "24px",
          width: "300px",
          display: "none",
          pointerEvents: "auto",
          flexDirection: "column",
          gap: "12px",
        },
      },
      [
        el("div", { text: "VOICE SETTINGS", style: { fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "14px", letterSpacing: "0.04em" } }),
        el("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } }, [
          el("label", { text: "MICROPHONE", style: { fontFamily: "var(--font-mono)", fontSize: "10px", color: "var(--text-muted)", letterSpacing: "0.06em" } }),
          this.deviceSelectEl,
        ]),
        el("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } }, [
          el("label", { text: "TEST MY MIC", style: { fontFamily: "var(--font-mono)", fontSize: "10px", color: "var(--text-muted)", letterSpacing: "0.06em" } }),
          el("div", { style: { height: "10px", borderRadius: "5px", background: "var(--bg-raised)", border: "1px solid var(--border-strong)", overflow: "hidden" } }, [
            this.levelMeterFillEl,
          ]),
          this.levelMeterMessageEl,
        ]),
        el("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } }, [
          el("div", { style: { display: "flex", justifyContent: "space-between" } }, [
            el("label", { text: "OTHERS' VOLUME", style: { fontFamily: "var(--font-mono)", fontSize: "10px", color: "var(--text-muted)", letterSpacing: "0.06em" } }),
            this.volumeValueEl,
          ]),
          volumeSliderEl,
        ]),
        closeBtnEl,
      ],
    );
    root.appendChild(this.panelEl);

    voice.on("micStateChanged", () => this.refreshLevelMeterAvailability());
  }

  get isOpen(): boolean {
    return this.open_;
  }

  toggle() {
    if (this.open_) this.close();
    else this.open();
  }

  open() {
    this.open_ = true;
    this.panelEl.style.display = "flex";
    void this.refreshDeviceList();
    this.refreshLevelMeterAvailability();
  }

  close() {
    this.open_ = false;
    this.panelEl.style.display = "none";
    this.stopLevelMeter();
  }

  /** Device labels are only populated by the browser once permission has
   * been granted at least once this session — before that, options show
   * generic "Microphone 1/2/…" labels, same behavior every site with a
   * device picker has to live with (not something to special-case). */
  private async refreshDeviceList() {
    let devices: MediaDeviceInfo[] = [];
    try {
      devices = await LKRoom.getLocalDevices("audioinput");
    } catch (err) {
      console.warn("[voiceSettingsPanel] failed to enumerate input devices:", err);
    }
    this.deviceSelectEl.innerHTML = "";
    devices.forEach((d, i) => {
      const option = el("option", { text: d.label || `Microphone ${i + 1}`, attrs: { value: d.deviceId } });
      this.deviceSelectEl.appendChild(option);
    });
    const selected = voice.selectedInputDeviceId;
    if (selected) this.deviceSelectEl.value = selected;
  }

  private refreshLevelMeterAvailability() {
    if (!this.open_) return;
    if (voice.permissionState === "granted") {
      this.levelMeterMessageEl.style.display = "none";
      this.startLevelMeter();
    } else {
      this.levelMeterMessageEl.style.display = "block";
      this.stopLevelMeter();
    }
  }

  /** A second, independent AnalyserNode tapped off the already-published
   * mic track — reading a track never modifies or consumes it, so this
   * has zero effect on what's actually being transmitted over LiveKit.
   * Only runs while this panel is open (see open()/close()), not for
   * the whole session. */
  private startLevelMeter() {
    if (this.analyser) return; // already running
    const track = voice.getLocalMicTrack();
    if (!track) return;

    const audioContext = voice.getAudioContext();
    this.analyserSource = audioContext.createMediaStreamSource(new MediaStream([track]));
    this.analyser = audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyserSource.connect(this.analyser);

    const data = new Uint8Array(this.analyser.frequencyBinCount);
    const tick = () => {
      if (!this.analyser) return;
      this.analyser.getByteFrequencyData(data);
      const avg = data.reduce((sum, v) => sum + v, 0) / data.length;
      // *2 headroom — a typical speaking voice's average frequency-bin
      // level sits well under half of the 0-255 range, so a flat 1:1
      // mapping reads as barely-moving even at normal volume.
      this.levelMeterFillEl.style.width = `${Math.min(100, (avg / 255) * 200)}%`;
      this.meterRafId = requestAnimationFrame(tick);
    };
    tick();
  }

  private stopLevelMeter() {
    if (this.meterRafId !== null) cancelAnimationFrame(this.meterRafId);
    this.meterRafId = null;
    this.analyserSource?.disconnect();
    this.analyserSource = null;
    this.analyser = null;
    this.levelMeterFillEl.style.width = "0%";
  }
}
