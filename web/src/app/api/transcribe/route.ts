import { NextResponse } from "next/server";
import OpenAI, { toFile } from "openai";
import { supabaseServerFromRequest } from "@/lib/supabaseServer";

export const maxDuration = 60;

/**
 * POST /api/transcribe — multipart form with a `file` audio blob.
 * Returns { text }.
 *
 * Model: OPENAI_TRANSCRIBE_MODEL if set, else gpt-transcribe. If that model
 * isn't available on the account we retry once with gpt-4o-transcribe.
 */

const PRIMARY_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-transcribe";
const FALLBACK_MODEL = "gpt-4o-transcribe";

// Vercel rejects request bodies over ~4.5 MB before they get here; this just
// guards against direct calls. OpenAI's own limit is 25 MB.
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Words the model should spell this way. Passed as the transcription prompt,
 * which biases recognition toward this vocabulary and style. Add terms here
 * when you notice a word getting mis-heard repeatedly.
 */
const VOCABULARY = [
  // Tennis — see the recurring errors listed in lib/tennis/parse-contract.ts
  "groundstrokes", "backhands", "forehand", "lobs", "poach", "poaching",
  "faults", "serves", "volleys", "overheads", "inside-in", "7.5 combo league",
  "3.5 doubles", "USTA", "tiebreak",
  // Training
  "squats", "bench", "deadlift", "RDLs", "RPE", "Zone 2", "HRV", "Oura",
];

function buildPrompt(bookTitles: string[]): string {
  const parts = [
    "Personal journal entry, dictated. Use proper punctuation and capitalization.",
    `Vocabulary: ${VOCABULARY.join(", ")}.`,
  ];
  if (bookTitles.length) parts.push(`Books: ${bookTitles.join("; ")}.`);
  return parts.join(" ");
}

function isModelUnavailable(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError)) return false;
  if (err.status === 404) return true;
  const code = String(err.code ?? "");
  return code === "model_not_found" || /model/i.test(err.message) && err.status === 400;
}

export async function POST(req: Request) {
  const supabase = supabaseServerFromRequest(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      {
        error: "Voice transcription isn't set up (OPENAI_API_KEY missing). Using browser dictation instead — tap the mic again.",
        code: "not_configured",
      },
      { status: 503 }
    );
  }

  let file: File | null;
  try {
    const form = await req.formData();
    file = form.get("file") as File | null;
  } catch {
    return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
  }
  if (!file || file.size === 0) {
    return NextResponse.json({ error: "No audio provided" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "Recording too long" }, { status: 413 });
  }

  // Recent books help with author/title spelling in reading notes. Best effort.
  let bookTitles: string[] = [];
  try {
    const { data } = await supabase
      .from("books")
      .select("title, author")
      .eq("owner_id", user.id)
      .order("updated_at", { ascending: false })
      .limit(10);
    bookTitles = (data ?? [])
      .map((b: { title?: string; author?: string }) =>
        [b.title, b.author].filter(Boolean).join(" by ")
      )
      .filter(Boolean);
  } catch {
    /* prompt works fine without it */
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const audio = await toFile(Buffer.from(await file.arrayBuffer()), file.name || "speech.webm", {
    type: file.type || "audio/webm",
  });
  const prompt = buildPrompt(bookTitles);

  const transcribe = (model: string) =>
    client.audio.transcriptions.create({
      file: audio,
      model,
      language: "en",
      prompt,
      response_format: "json",
    });

  try {
    let result;
    try {
      result = await transcribe(PRIMARY_MODEL);
    } catch (err) {
      if (PRIMARY_MODEL === FALLBACK_MODEL || !isModelUnavailable(err)) throw err;
      console.warn(`[transcribe] ${PRIMARY_MODEL} unavailable, falling back to ${FALLBACK_MODEL}`);
      result = await transcribe(FALLBACK_MODEL);
    }
    return NextResponse.json({ text: result.text ?? "" });
  } catch (err) {
    console.error("[transcribe] failed:", err);
    const message = err instanceof OpenAI.APIError ? err.message : "Transcription failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
