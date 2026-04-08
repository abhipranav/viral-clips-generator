import { z } from "zod";

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
}

const configSchema = z.object({
  openaiApiKey: z.string().default(""),
  whisperModel: z.enum(["tiny", "base", "small", "medium", "large"]).default("tiny"),
  maxParallelClips: z.coerce.number().int().min(1).max(10).default(1),
  silenceThresholdDb: z.coerce.number().default(-35),
  silenceMinDuration: z.coerce.number().default(0.8),
  outputWidth: z.coerce.number().default(1080),
  outputHeight: z.coerce.number().default(1920),
  clipSpeed: z.coerce.number().min(1).max(2).default(1.2),
  maxClips: z.coerce.number().int().min(0).default(5),
  preferYouTubeTranscripts: z.boolean().default(false),
  captionAnimate: z.boolean().default(true),
  generateCaptions: z.boolean().default(false),
  removeSilence: z.boolean().default(true),
  whisperCliBin: z.string().default("whisper-cli"),
  whisperCliModelPath: z.string().default(""),
  serverHost: z.string().default("0.0.0.0"),
  serverPort: z.coerce.number().int().min(1).max(65535).default(3001),
  jobConcurrency: z.coerce.number().int().min(1).max(4).default(1),
  maxUploadSizeMb: z.coerce.number().int().min(100).max(10_240).default(4096),
  paths: z
    .object({
      data: z.string().default("./data"),
      output: z.string().default("./output"),
      assets: z.string().default("./assets"),
      subwaySurfers: z.string().default("./assets/subway-surfers"),
      uploads: z.string().default("./data/uploads"),
      checkpointDb: z.string().default("./data/checkpoints.db"),
    })
    .default({}),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(options?: { requireOpenAiApiKey?: boolean }): Config {
  const config = configSchema.parse({
    openaiApiKey: Bun.env.OPENAI_API_KEY,
    whisperModel: Bun.env.WHISPER_MODEL,
    maxParallelClips: Bun.env.MAX_PARALLEL_CLIPS,
    silenceThresholdDb: Bun.env.SILENCE_THRESHOLD_DB,
    silenceMinDuration: Bun.env.SILENCE_MIN_DURATION,
    outputWidth: Bun.env.OUTPUT_WIDTH,
    outputHeight: Bun.env.OUTPUT_HEIGHT,
    clipSpeed: Bun.env.CLIP_SPEED,
    maxClips: Bun.env.MAX_CLIPS,
    preferYouTubeTranscripts: parseBooleanEnv(Bun.env.PREFER_YOUTUBE_TRANSCRIPTS),
    captionAnimate: parseBooleanEnv(Bun.env.CAPTION_ANIMATE),
    generateCaptions: parseBooleanEnv(Bun.env.GENERATE_CAPTIONS),
    removeSilence: parseBooleanEnv(Bun.env.REMOVE_SILENCE),
    whisperCliBin: Bun.env.WHISPER_CLI_BIN,
    whisperCliModelPath: Bun.env.WHISPER_CLI_MODEL_PATH,
    serverHost: Bun.env.SERVER_HOST,
    serverPort: Bun.env.SERVER_PORT,
    jobConcurrency: Bun.env.JOB_CONCURRENCY,
    maxUploadSizeMb: Bun.env.MAX_UPLOAD_SIZE_MB,
    paths: {
      data: Bun.env.DATA_DIR,
      output: Bun.env.OUTPUT_DIR,
      assets: Bun.env.ASSETS_DIR,
      subwaySurfers: Bun.env.SUBWAY_SURFERS_DIR,
      uploads: Bun.env.UPLOADS_DIR,
      checkpointDb: Bun.env.CHECKPOINT_DB_PATH,
    },
  });

  if (options?.requireOpenAiApiKey !== false && !config.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required for pipeline execution.");
  }

  return config;
}
