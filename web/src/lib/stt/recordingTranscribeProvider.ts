import type { STTProvider, STTResult, STTStatus } from "./types";
import { getAuthHeaders } from "@/lib/authHeaders";

/**
 * Records audio in the browser and sends it to /api/transcribe, which runs
 * it through OpenAI's transcription model. Much more accurate than the Web
 * Speech API, at the cost of no live preview: text arrives a second or two
 * after you stop.
 */

// Vercel caps request bodies at ~4.5 MB. At 32 kbps that's ~18 minutes, so
// stop well short of it.
const MAX_RECORDING_MS = 10 * 60 * 1000;
const AUDIO_BITS_PER_SECOND = 32_000;

// Preferred first. Chrome/Firefox/Android do webm; iOS Safari does mp4.
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t));
}

function extensionFor(mime: string): string {
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}

/** Set when the server says no API key is configured; we fall back to Web Speech. */
let serverUnavailable = false;
export function isServerTranscriptionUnavailable(): boolean {
  return serverUnavailable;
}

export class RecordingTranscribeProvider implements STTProvider {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  // Bumped on every start/cancel so stale async work (mic permission prompt,
  // in-flight upload) can tell it's been superseded and drop its result.
  private session = 0;
  private stopRequested = false;

  isSupported(): boolean {
    return (
      typeof window !== "undefined" &&
      typeof MediaRecorder !== "undefined" &&
      !!navigator.mediaDevices?.getUserMedia &&
      pickMimeType() !== undefined
    );
  }

  startListening(
    onResult: (result: STTResult) => void,
    onError: (error: string) => void,
    onStatus?: (status: STTStatus) => void
  ): void {
    const session = ++this.session;
    this.stopRequested = false;
    this.chunks = [];
    onStatus?.("listening");

    const mimeType = pickMimeType()!;

    navigator.mediaDevices
      .getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      .then((stream) => {
        if (session !== this.session) {
          // Cancelled while the permission prompt was up.
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        this.stream = stream;

        const recorder = new MediaRecorder(stream, {
          mimeType,
          audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
        });
        this.recorder = recorder;

        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) this.chunks.push(e.data);
        };

        recorder.onstop = () => {
          this.releaseMic();
          if (session !== this.session) return; // cancelled
          const blob = new Blob(this.chunks, { type: recorder.mimeType || mimeType });
          this.chunks = [];
          void this.upload(session, blob, onResult, onError, onStatus);
        };

        recorder.start(1000);
        this.maxTimer = setTimeout(() => this.stopListening(), MAX_RECORDING_MS);

        // Stop was tapped before the mic finished opening.
        if (this.stopRequested) this.stopListening();
      })
      .catch((err: unknown) => {
        if (session !== this.session) return;
        const name = err instanceof DOMException ? err.name : "";
        onError(
          name === "NotAllowedError"
            ? "Microphone access was denied."
            : "Couldn't access the microphone."
        );
        onStatus?.("idle");
      });
  }

  private async upload(
    session: number,
    blob: Blob,
    onResult: (result: STTResult) => void,
    onError: (error: string) => void,
    onStatus?: (status: STTStatus) => void
  ): Promise<void> {
    // Under ~0.3s of audio — nothing worth sending.
    if (blob.size < 1500) {
      onStatus?.("idle");
      return;
    }

    onStatus?.("transcribing");
    try {
      const form = new FormData();
      form.append("file", blob, `speech.${extensionFor(blob.type)}`);
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: await getAuthHeaders(),
        body: form,
      });
      const json = await res.json().catch(() => ({}));
      if (session !== this.session) return;

      if (!res.ok) {
        if (json.code === "not_configured") serverUnavailable = true;
        onError(json.error || `Transcription failed (${res.status}).`);
        return;
      }

      const text = typeof json.text === "string" ? json.text.trim() : "";
      if (text) onResult({ transcript: text, isFinal: true });
    } catch {
      if (session === this.session) onError("Transcription failed — check your connection.");
    } finally {
      if (session === this.session) onStatus?.("idle");
    }
  }

  stopListening(): void {
    this.stopRequested = true;
    if (this.maxTimer) {
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.stop(); // onstop does the upload
    }
    this.recorder = null;
  }

  cancel(): void {
    this.session++;
    this.stopListening();
    this.releaseMic();
    this.chunks = [];
  }

  private releaseMic(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
