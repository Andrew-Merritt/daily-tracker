import type { STTProvider, STTResult } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecognition = any;

function getSpeechRecognitionConstructor(): (new () => AnyRecognition) | null {
  if (typeof window === "undefined") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export class WebSpeechProvider implements STTProvider {
  private recognition: AnyRecognition = null;

  isSupported(): boolean {
    return getSpeechRecognitionConstructor() !== null;
  }

  startListening(
    onResult: (result: STTResult) => void,
    onError: (error: string) => void
  ): void {
    const Constructor = getSpeechRecognitionConstructor();
    if (!Constructor) {
      onError("Speech recognition is not supported in this browser.");
      return;
    }

    this.recognition = new Constructor();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = "en-US";

    this.recognition.onresult = (event: AnyRecognition) => {
      let interimTranscript = "";
      let finalTranscript = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        } else {
          interimTranscript += result[0].transcript;
        }
      }

      if (finalTranscript) {
        onResult({ transcript: finalTranscript, isFinal: true });
      } else if (interimTranscript) {
        onResult({ transcript: interimTranscript, isFinal: false });
      }
    };

    this.recognition.onerror = (event: AnyRecognition) => {
      if (event.error !== "aborted") {
        onError(`Speech recognition error: ${event.error}`);
      }
    };

    this.recognition.start();
  }

  stopListening(): void {
    if (this.recognition) {
      this.recognition.stop();
      this.recognition = null;
    }
  }

  cancel(): void {
    if (this.recognition) {
      this.recognition.abort();
      this.recognition = null;
    }
  }
}
