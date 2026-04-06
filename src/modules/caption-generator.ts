import { createLogger } from "../utils/logger";
import { getVideoDuration, runFfmpeg } from "../utils/ffmpeg";
import { ensureDir } from "../utils/fs";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { existsSync } from "fs";
import { dirname, resolve, join } from "path";
import type { Config } from "../config";
import type { CaptionWord, CaptionGroup, CaptionOverlayProps } from "../remotion/types";

const log = createLogger("captions");
const FPS = 30;
const WORDS_PER_GROUP = 6;
const MODELS_DIR = resolve(__dirname, "../../models");

let bundlePromise: Promise<string> | null = null;

interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

interface PythonWhisperSegment {
  text: string;
  start: number;
  end: number;
  words?: Array<{
    word?: string;
    start?: number;
    end?: number;
  }>;
}

export class CaptionGenerator {
  async warmup(): Promise<void> {
    await this.ensureBundle();
  }

  private async ensureBundle(): Promise<string> {
    if (!bundlePromise) {
      log.info("Bundling Remotion project...");
      bundlePromise = bundle({
        entryPoint: resolve(__dirname, "../remotion/index.tsx"),
        webpackOverride: (config) => config,
      });
      const location = await bundlePromise;
      log.info(`Remotion bundle ready: ${location}`);
    }
    return bundlePromise;
  }

  async generate(desilencedClipPath: string, outputPath: string, config: Config): Promise<string> {
    const serveUrl = await this.ensureBundle();
    const clipDuration = await getVideoDuration(desilencedClipPath);
    const speed = config.clipSpeed;

    const workDir = dirname(outputPath);
    const whisperWords = await this.whisperWordTimestamps(desilencedClipPath, config, workDir);
    log.info(`Whisper extracted ${whisperWords.length} words`);

    const scaled = whisperWords.map((w) => ({
      text: w.word,
      start: w.start / speed,
      end: w.end / speed,
    }));

    const framed: CaptionWord[] = scaled.map((w) => ({
      text: w.text,
      startFrame: Math.round(w.start * FPS),
      endFrame: Math.round(w.end * FPS),
    }));

    const groups = this.groupWords(framed);
    const postSpeedDuration = clipDuration / speed;
    const durationInFrames = Math.ceil(postSpeedDuration * FPS);
    const width = config.outputWidth;
    const height = config.outputHeight;

    const inputProps: CaptionOverlayProps = {
      groups,
      width,
      height,
      fps: FPS,
      durationInFrames,
    };

    ensureDir(dirname(outputPath));

    log.info(`Rendering caption overlay (${groups.length} groups, ${durationInFrames} frames)...`);

    const composition = await selectComposition({
      serveUrl,
      id: "CaptionOverlay",
      inputProps,
    });

    let lastLoggedPct = -1;
    await renderMedia({
      composition,
      serveUrl,
      codec: "vp9",
      imageFormat: "png",
      pixelFormat: "yuva420p",
      outputLocation: outputPath,
      inputProps,
      onProgress: ({ progress }) => {
        const pct = Math.floor(progress * 100);
        if (pct >= lastLoggedPct + 10) {
          lastLoggedPct = pct;
          log.info(`Caption render: ${pct}%`);
        }
      },
    });

    log.info(`Caption overlay rendered: ${outputPath}`);
    return outputPath;
  }

  private async whisperWordTimestamps(
    videoPath: string,
    config: Config,
    workDir: string,
  ): Promise<WhisperWord[]> {
    try {
      return await this.fromWhisperCli(videoPath, config, workDir);
    } catch (err) {
      log.warn(`whisper-cli unavailable for captions: ${err}. Falling back to Python Whisper.`);
      return await this.fromPythonWhisper(videoPath, config);
    }
  }

  private async fromWhisperCli(
    videoPath: string,
    config: Config,
    workDir: string,
  ): Promise<WhisperWord[]> {
    const modelPath =
      config.whisperCliModelPath || join(MODELS_DIR, `ggml-${config.whisperModel}.bin`);

    if (!existsSync(modelPath)) {
      throw new Error(
        `Whisper CLI model file not found at ${modelPath}. Set WHISPER_CLI_MODEL_PATH or download the ggml model locally.`,
      );
    }

    log.info(`Running whisper-cli word-level transcription (model: ${config.whisperModel})...`);

    const wavPath = join(workDir, "caption_audio.wav");
    await runFfmpeg(["-i", videoPath, "-ar", "16000", "-ac", "1", "-f", "wav", "-y", wavPath]);

    const jsonBase = join(workDir, "caption_words");
    const proc = Bun.spawn(
      [
        config.whisperCliBin,
        "-m",
        modelPath,
        "-f",
        wavPath,
        "-l",
        "en",
        "-oj",
        "--output-json-full",
        "-of",
        jsonBase,
        "-np",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw new Error(`whisper-cli failed: ${stderr}`);
    }

    const jsonPath = `${jsonBase}.json`;
    const json = await Bun.file(jsonPath).json();
    const words: WhisperWord[] = [];

    for (const segment of json.transcription) {
      for (const token of segment.tokens) {
        const text = token.text.trim();
        if (!text || text.startsWith("[")) continue;
        if ((/^[,.\?!;:]$/.test(text) || text.startsWith("'")) && words.length > 0) {
          words[words.length - 1].word += text;
          words[words.length - 1].end = token.offsets.to / 1000;
        } else {
          words.push({
            word: text,
            start: token.offsets.from / 1000,
            end: token.offsets.to / 1000,
          });
        }
      }
    }

    return words;
  }

  private async fromPythonWhisper(videoPath: string, config: Config): Promise<WhisperWord[]> {
    log.info(`Running Python Whisper fallback for captions (model: ${config.whisperModel})...`);

    const script = `
import json
import whisper

model = whisper.load_model(${JSON.stringify(config.whisperModel)})
result = model.transcribe(${JSON.stringify(videoPath)}, language="en", word_timestamps=True)
segments = []
for seg in result.get("segments", []):
    segments.append({
        "text": seg.get("text", "").strip(),
        "start": seg.get("start", 0),
        "end": seg.get("end", 0),
        "words": [
            {
                "word": word.get("word", ""),
                "start": word.get("start"),
                "end": word.get("end"),
            }
            for word in seg.get("words", []) or []
        ],
    })
print(json.dumps(segments))
`;

    const proc = Bun.spawn(["python3", "-c", script], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw new Error(`Python Whisper fallback failed: ${stderr}`);
    }

    const segments = JSON.parse(stdout) as PythonWhisperSegment[];
    const words = this.expandPythonSegmentsToWords(segments);

    if (words.length === 0) {
      throw new Error("Python Whisper fallback produced no caption words.");
    }

    log.info(`Python Whisper fallback extracted ${words.length} words`);
    return words;
  }

  private expandPythonSegmentsToWords(segments: PythonWhisperSegment[]): WhisperWord[] {
    const words: WhisperWord[] = [];

    for (const segment of segments) {
      const explicitWords = this.extractExplicitWords(segment);
      if (explicitWords.length > 0) {
        words.push(...explicitWords);
        continue;
      }

      words.push(...this.estimateWordsFromSegment(segment));
    }

    return words;
  }

  private extractExplicitWords(segment: PythonWhisperSegment): WhisperWord[] {
    const explicitWords = segment.words ?? [];
    const words: WhisperWord[] = [];

    for (const entry of explicitWords) {
      const text = entry.word?.trim();
      if (!text || text.startsWith("[")) {
        continue;
      }

      if (
        (/^[,.\?!;:]$/.test(text) || text.startsWith("'")) &&
        words.length > 0 &&
        entry.end !== undefined
      ) {
        words[words.length - 1].word += text;
        words[words.length - 1].end = entry.end;
        continue;
      }

      if (entry.start === undefined || entry.end === undefined) {
        continue;
      }

      words.push({
        word: text,
        start: entry.start,
        end: entry.end,
      });
    }

    return words;
  }

  private estimateWordsFromSegment(segment: PythonWhisperSegment): WhisperWord[] {
    const tokens = segment.text
      .split(/\s+/)
      .map((word) => word.trim())
      .filter(Boolean);

    if (tokens.length === 0) {
      return [];
    }

    const duration = Math.max(0.12, segment.end - segment.start);
    const perWord = duration / tokens.length;

    return tokens.map((word, index) => {
      const start = segment.start + perWord * index;
      const end = index === tokens.length - 1 ? segment.end : segment.start + perWord * (index + 1);
      return {
        word,
        start,
        end: Math.max(start + 0.05, end),
      };
    });
  }

  private groupWords(words: CaptionWord[]): CaptionGroup[] {
    const groups: CaptionGroup[] = [];

    for (let i = 0; i < words.length; i += WORDS_PER_GROUP) {
      const chunk = words.slice(i, i + WORDS_PER_GROUP);
      groups.push({
        words: chunk,
        startFrame: chunk[0].startFrame,
        endFrame: chunk[chunk.length - 1].endFrame,
      });
    }

    return groups;
  }
}
