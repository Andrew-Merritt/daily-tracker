import { useState, useRef, useCallback, useEffect } from "react";
import { getSTTProvider, type STTProvider } from "@/lib/stt";

interface UseSpeechInputOptions {
  /** Current value of the textarea, used to restore on cancel */
  value: string;
  /** Called with the new value as speech is recognized */
  onChange: (value: string) => void;
  /** Called when recording or transcription fails */
  onError?: (message: string) => void;
}

interface UseSpeechInputReturn {
  isSupported: boolean;
  isListening: boolean;
  /** Audio captured, waiting on the server for the text */
  isTranscribing: boolean;
  interim: string;
  startListening: () => void;
  stopListening: () => void;
  cancel: () => void;
}

export function useSpeechInput({
  value,
  onChange,
  onError,
}: UseSpeechInputOptions): UseSpeechInputReturn {
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [interim, setInterim] = useState("");

  // Snapshot of value at the moment recording started — used for cancel
  const baseValueRef = useRef<string>("");
  // Accumulates finalized speech segments during this session
  const accumulatedRef = useRef<string>("");

  const providerRef = useRef<STTProvider | null>(null);
  if (providerRef.current === null) providerRef.current = getSTTProvider();
  const isSupported = providerRef.current.isSupported();

  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const stopListening = useCallback(() => {
    // Server-backed providers deliver the final text after this returns, so
    // leave baseValueRef/accumulatedRef intact until the next start.
    providerRef.current?.stopListening();
    setIsListening(false);
    setInterim("");
  }, []);

  const startListening = useCallback(() => {
    if (!isSupported || isListening || isTranscribing) return;

    // Re-resolve in case we've had to fall back (e.g. no server API key).
    providerRef.current = getSTTProvider();
    const provider = providerRef.current;

    // Snapshot current value so we know what was there before recording
    baseValueRef.current = value;
    accumulatedRef.current = "";
    setIsListening(true);
    setInterim("");

    provider.startListening(
      (result) => {
        if (result.isFinal) {
          // Auto-add a period if the segment doesn't end with sentence punctuation
          const raw = result.transcript.trim();
          if (!raw) return;
          const endsWithPunctuation = /[.!?,;:]$/.test(raw);
          const segment = endsWithPunctuation ? raw : `${raw}.`;

          // Append final result (with a space separator if needed)
          const separator = accumulatedRef.current ? " " : "";
          accumulatedRef.current += separator + segment;
          setInterim("");
          onChange(
            baseValueRef.current +
              (baseValueRef.current ? " " : "") +
              accumulatedRef.current
          );
        } else {
          // Show interim as a preview; don't commit yet
          setInterim(result.transcript);
        }
      },
      (error) => {
        setIsListening(false);
        setIsTranscribing(false);
        setInterim("");
        onErrorRef.current?.(error);
      },
      (status) => {
        setIsTranscribing(status === "transcribing");
        if (status === "idle") setIsListening(false);
      }
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSupported, isListening, isTranscribing, onChange]);

  const cancel = useCallback(() => {
    providerRef.current?.cancel();
    setIsListening(false);
    setIsTranscribing(false);
    setInterim("");
    accumulatedRef.current = "";
    // Restore the value to what it was before recording started
    onChange(baseValueRef.current);
  }, [onChange]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      providerRef.current?.cancel();
    };
  }, []);

  return {
    isSupported,
    isListening,
    isTranscribing,
    interim,
    startListening,
    stopListening,
    cancel,
  };
}
