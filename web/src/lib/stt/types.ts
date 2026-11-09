export interface STTResult {
  transcript: string;
  isFinal: boolean;
}

/**
 * - "listening": capturing audio
 * - "transcribing": audio captured, waiting on the server for text
 * - "idle": done (a final result, if any, has already been delivered)
 */
export type STTStatus = "listening" | "transcribing" | "idle";

export interface STTProvider {
  isSupported(): boolean;
  startListening(
    onResult: (result: STTResult) => void,
    onError: (error: string) => void,
    onStatus?: (status: STTStatus) => void
  ): void;
  /** Stop capturing and deliver whatever was said (may be async). */
  stopListening(): void;
  /** Stop capturing and throw away the audio — no result is delivered. */
  cancel(): void;
}
