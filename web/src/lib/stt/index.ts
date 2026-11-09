export type { STTProvider, STTResult, STTStatus } from "./types";
export { WebSpeechProvider } from "./webSpeechProvider";
export { RecordingTranscribeProvider } from "./recordingTranscribeProvider";

import type { STTProvider } from "./types";
import { WebSpeechProvider } from "./webSpeechProvider";
import {
  RecordingTranscribeProvider,
  isServerTranscriptionUnavailable,
} from "./recordingTranscribeProvider";

/**
 * Prefer server-side transcription (OpenAI) for accuracy. Fall back to the
 * browser's built-in Web Speech API when the browser can't record audio, or
 * when the server has told us no OpenAI key is configured.
 */
export function getSTTProvider(): STTProvider {
  const recording = new RecordingTranscribeProvider();
  if (recording.isSupported() && !isServerTranscriptionUnavailable()) {
    return recording;
  }
  return new WebSpeechProvider();
}
