"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { useSpeechInput } from "@/hooks/useSpeechInput";
import { useToast } from "@/components/ui/Toast";

export interface SpeechTextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  value: string;
  onChange: React.ChangeEventHandler<HTMLTextAreaElement>;
}

/**
 * Drop-in replacement for <textarea> / <Textarea> that adds a mic button
 * for speech-to-text input. Uses the STT provider from @/lib/stt (OpenAI
 * transcription via /api/transcribe, falling back to the Web Speech API).
 */
const SpeechTextarea = React.forwardRef<
  HTMLTextAreaElement,
  SpeechTextareaProps
>(({ className, value, onChange, ...props }, ref) => {
  const handleChange = React.useCallback(
    (newValue: string) => {
      const syntheticEvent = {
        target: { value: newValue },
        currentTarget: { value: newValue },
      } as React.ChangeEvent<HTMLTextAreaElement>;
      onChange(syntheticEvent);
    },
    [onChange]
  );

  const { toast } = useToast();
  const handleError = React.useCallback(
    (message: string) => toast(message, "error"),
    [toast]
  );

  const {
    isSupported,
    isListening,
    isTranscribing,
    interim,
    startListening,
    stopListening,
    cancel,
  } = useSpeechInput({
    value: value as string,
    onChange: handleChange,
    onError: handleError,
  });
  const isBusy = isListening || isTranscribing;

  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={isListening && interim ? `${value}${value ? " " : ""}${interim}` : value}
        onChange={onChange}
        className={cn(
          "flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          isBusy && "pr-16",
          className
        )}
        autoCapitalize={(props.autoCapitalize as string) ?? "sentences"}
        {...props}
        // Typing while the transcript is in flight would be overwritten.
        readOnly={isTranscribing || props.readOnly}
      />

      {isSupported && (
        <div className="absolute bottom-2 right-2 flex items-center gap-1">
          {isBusy && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={cancel}
              className="flex items-center justify-center w-8 h-8 rounded text-muted-foreground hover:text-destructive transition-colors"
              title="Cancel recording"
              aria-label="Cancel recording"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}

          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={isListening ? stopListening : startListening}
            disabled={isTranscribing}
            className={cn(
              "flex items-center justify-center w-6 h-6 rounded transition-colors",
              isListening
                ? "text-red-500 hover:text-red-600"
                : "text-muted-foreground hover:text-foreground"
            )}
            title={
              isTranscribing
                ? "Transcribing…"
                : isListening
                  ? "Stop recording"
                  : "Start voice input"
            }
            aria-label={
              isTranscribing
                ? "Transcribing"
                : isListening
                  ? "Stop recording"
                  : "Start voice input"
            }
          >
            {isTranscribing ? (
              // Spinner while the server transcribes
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
            ) : isListening ? (
              // Pulsing dot to indicate active recording
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
              </span>
            ) : (
              // Mic icon
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="22" />
              </svg>
            )}
          </button>
        </div>
      )}
    </div>
  );
});

SpeechTextarea.displayName = "SpeechTextarea";

export { SpeechTextarea };
