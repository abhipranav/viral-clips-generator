import { createLogger } from "../utils/logger";
import type { Config } from "../config";
import type { ClipCandidate, Transcript, VideoMetadata } from "../pipeline/types";

const log = createLogger("clip-identifier");
const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const OPENAI_CLIP_MODEL = "gpt-5-mini";
const MAX_OPENAI_ATTEMPTS = 4;
const BASE_RETRY_DELAY_MS = 2000;

const CLIP_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    clips: {
      type: "array" as const,
      items: {
        type: "object" as const,
        additionalProperties: false,
        properties: {
          title: { type: "string" as const },
          hookLine: { type: "string" as const },
          startTime: { type: "number" as const },
          endTime: { type: "number" as const },
          reasoning: { type: "string" as const },
          viralScore: { type: "number" as const },
          tags: { type: "array" as const, items: { type: "string" as const } },
        },
        required: ["title", "hookLine", "startTime", "endTime", "reasoning", "viralScore", "tags"],
      },
    },
  },
  required: ["clips"],
};

interface OpenAiErrorResponse {
  error?: {
    message?: string;
  };
}

interface OpenAiTextContent {
  type: string;
  text?: string;
  refusal?: string;
}

interface OpenAiOutputItem {
  type: string;
  content?: OpenAiTextContent[];
}

interface OpenAiResponseBody extends OpenAiErrorResponse {
  output_text?: string;
  output?: OpenAiOutputItem[];
  incomplete_details?: {
    reason?: string;
  } | null;
}

export class ClipIdentifier {
  private apiKey: string;

  constructor(config: Config) {
    this.apiKey = config.openaiApiKey;
  }

  async identify(transcript: Transcript, metadata: VideoMetadata): Promise<ClipCandidate[]> {
    log.info("Analyzing transcript for clip-worthy segments...");

    const formattedTranscript = transcript.segments
      .map((s) => `[${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s] ${s.text}`)
      .join("\n");

    const prompt = `You are a viral content strategist specializing in history/education TikTok and YouTube Shorts.

Analyze this lecture transcript from "${metadata.title}" (total duration: ${metadata.duration} seconds) and identify segments that would make compelling short-form clips (30-90 seconds each).

Look for:
- Surprising or counterintuitive historical facts
- Dramatic storytelling moments
- Mind-blowing connections between historical events
- Controversial or thought-provoking claims
- Quotable one-liners or powerful statements
- "Did you know?" moments that make people stop scrolling

Each clip MUST:
- Be 30-90 seconds long
- Be self-contained (makes sense without surrounding context)
- Start with a hook that grabs attention in the first 3 seconds
- Have a clear payoff or revelation

IMPORTANT: The timestamps in the transcript are in SECONDS (e.g., 533.0s means 533 seconds into the video).
Return startTime and endTime as numbers in SECONDS (not minutes:seconds). For example, if a clip starts at 8 minutes 53 seconds, return startTime: 533.

TRANSCRIPT:
${formattedTranscript}

Return clips sorted by viralScore (highest first). Aim for 5-15 clips depending on video length.`;

    const text = await this.generateContentWithRetry(prompt);
    const parsed = JSON.parse(text) as {
      clips: Array<{
        title: string;
        hookLine: string;
        startTime: number;
        endTime: number;
        reasoning: string;
        viralScore: number;
        tags: string[];
      }>;
    };

    log.info(
      `OpenAI ${OPENAI_CLIP_MODEL} returned ${parsed.clips.length} raw clips (video duration: ${metadata.duration}s)`,
    );
    for (const c of parsed.clips) {
      const dur = c.endTime - c.startTime;
      log.debug(
        `  "${c.title}" ${c.startTime}s-${c.endTime}s (${dur.toFixed(0)}s) score=${c.viralScore}`,
      );
    }

    const candidates: ClipCandidate[] = parsed.clips
      .filter((c) => {
        const duration = c.endTime - c.startTime;
        if (duration < 15 || duration > 120 || c.startTime < 0 || c.endTime > metadata.duration) {
          log.debug(
            `  Filtered out: "${c.title}" (dur=${duration.toFixed(0)}s, end=${c.endTime}, max=${metadata.duration})`,
          );
          return false;
        }
        return true;
      })
      .map((c) => ({
        id: crypto.randomUUID(),
        title: c.title,
        hookLine: c.hookLine,
        startTime: c.startTime,
        endTime: c.endTime,
        duration: c.endTime - c.startTime,
        reasoning: c.reasoning,
        viralScore: c.viralScore,
        tags: c.tags,
      }))
      .sort((a, b) => b.viralScore - a.viralScore);

    log.info(`Identified ${candidates.length} clip candidates`);
    return candidates;
  }

  private async generateContentWithRetry(prompt: string): Promise<string> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_OPENAI_ATTEMPTS; attempt++) {
      try {
        if (attempt > 1) {
          log.info(
            `Retrying OpenAI clip identification with ${OPENAI_CLIP_MODEL} (${attempt}/${MAX_OPENAI_ATTEMPTS})...`,
          );
        }

        const response = await fetch(OPENAI_API_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: OPENAI_CLIP_MODEL,
            input: prompt,
            text: {
              format: {
                type: "json_schema",
                name: "clip_candidates",
                strict: true,
                schema: CLIP_SCHEMA,
              },
            },
          }),
        });

        const body = (await this.parseJsonResponse(response)) as OpenAiResponseBody;
        if (!response.ok) {
          const message =
            body.error?.message || `OpenAI request failed with status ${response.status}`;
          throw new OpenAiRequestError(message, response.status);
        }

        return this.extractJsonText(body);
      } catch (err) {
        lastError = err;
        if (!isRetryableOpenAiError(err) || attempt === MAX_OPENAI_ATTEMPTS) {
          throw err;
        }

        const delayMs = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
        log.warn(`OpenAI temporarily unavailable. Retrying in ${delayMs / 1000}s...`);
        await Bun.sleep(delayMs);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`OpenAI request failed: ${lastError}`);
  }

  private async parseJsonResponse(response: Response): Promise<unknown> {
    const raw = await response.text();
    if (!raw.trim()) {
      return {};
    }

    try {
      return JSON.parse(raw);
    } catch {
      return {
        error: {
          message: raw,
        },
      };
    }
  }

  private extractJsonText(body: OpenAiResponseBody): string {
    if (typeof body.output_text === "string" && body.output_text.trim()) {
      return body.output_text;
    }

    const text = body.output
      ?.flatMap((item) => item.content ?? [])
      .map((content) => {
        if (content.type === "refusal" && content.refusal) {
          throw new Error(`OpenAI refused clip identification: ${content.refusal}`);
        }

        return content.type === "output_text" ? (content.text ?? "") : "";
      })
      .join("")
      .trim();

    if (text) {
      return text;
    }

    if (body.incomplete_details?.reason) {
      throw new Error(`OpenAI returned an incomplete response: ${body.incomplete_details.reason}`);
    }

    throw new Error("OpenAI returned no structured output for clip identification.");
  }
}

class OpenAiRequestError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "OpenAiRequestError";
    this.status = status;
  }
}

function isRetryableOpenAiError(err: unknown): boolean {
  if (err instanceof OpenAiRequestError && err.status !== undefined) {
    return err.status === 408 || err.status === 409 || err.status === 429 || err.status >= 500;
  }

  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);

  return (
    message.includes("429") ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504") ||
    message.includes("rate limit") ||
    message.includes("temporarily unavailable") ||
    message.includes("overloaded")
  );
}
