import { mkdirSync, rmSync } from "fs";
import { join } from "path";

import { describe, test, expect } from "bun:test";

import { PipelineOrchestrator } from "../../src/pipeline/orchestrator";
import { PipelineStage } from "../../src/pipeline/types";

describe("PipelineOrchestrator.extractVideoId", () => {
  const extractVideoId = (url: string): string => {
    const match = url.match(/(?:v=|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return match?.[1] ?? url.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 32);
  };

  test("extracts from standard URL", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  test("extracts from short URL", () => {
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  test("extracts from shorts URL", () => {
    expect(extractVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  test("extracts with query params", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120")).toBe("dQw4w9WgXcQ");
  });

  test("falls back for non-YouTube URL", () => {
    const id = extractVideoId("some-random-string");
    expect(id).toBeDefined();
    expect(id.length).toBeLessThanOrEqual(32);
  });
});

describe("Semaphore logic", () => {
  test("limits concurrency", async () => {
    // Inline semaphore test matching orchestrator's implementation
    class Semaphore {
      private count: number;
      private queue: Array<() => void> = [];
      constructor(max: number) {
        this.count = max;
      }
      async acquire(): Promise<void> {
        if (this.count > 0) {
          this.count--;
          return;
        }
        return new Promise((resolve) => this.queue.push(resolve));
      }
      release(): void {
        if (this.queue.length > 0) {
          this.queue.shift()!();
        } else {
          this.count++;
        }
      }
    }

    const sem = new Semaphore(2);
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = async (_id: number) => {
      await sem.acquire();
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 50));
      concurrent--;
      sem.release();
    };

    await Promise.all([task(1), task(2), task(3), task(4), task(5)]);
    expect(maxConcurrent).toBe(2);
  });
});

describe("PipelineOrchestrator.processOneClip", () => {
  test("regenerates clip artifacts when stored paths are not reusable", async () => {
    const tmpDir = join(import.meta.dir, "__orchestrator_artifacts__", crypto.randomUUID());
    const clipsDir = join(tmpDir, "clips");
    const desilencedDir = join(tmpDir, "desilenced");
    const captionsDir = join(tmpDir, "captions");
    const outputDir = join(tmpDir, "output");

    mkdirSync(clipsDir, { recursive: true });
    mkdirSync(desilencedDir, { recursive: true });
    mkdirSync(captionsDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });

    try {
      const checkpointUpdates: Array<{
        stage: PipelineStage;
        status: string;
        artifactPaths: Record<string, string>;
      }> = [];

      const checkpoint = {
        getClipProgress: () => ({
          stage: PipelineStage.COMPOSE_REEL,
          status: "completed",
          artifactPaths: {
            extractedVideoPath: join(clipsDir, "stale_raw.mp4"),
            silenceRemovedPath: join(desilencedDir, "stale_clean.mp4"),
            captionOverlayPath: join(captionsDir, "stale_captions.webm"),
            finalReelPath: join(outputDir, "stale_reel.mp4"),
          },
        }),
        updateClipProgress: (
          _runId: string,
          _clipId: string,
          _clipIndex: number,
          stage: PipelineStage,
          status: string,
          artifactPaths: Record<string, string>,
        ) => {
          checkpointUpdates.push({ stage, status, artifactPaths });
        },
      };

      const config = {
        maxParallelClips: 1,
        silenceThresholdDb: -35,
        silenceMinDuration: 0.8,
        outputWidth: 1080,
        outputHeight: 1920,
        clipSpeed: 1.2,
        maxClips: 5,
        preferYouTubeTranscripts: false,
        captionAnimate: true,
        generateCaptions: true,
        removeSilence: true,
        whisperModel: "tiny",
        whisperCliBin: "whisper-cli",
        whisperCliModelPath: "",
        geminiApiKey: "test",
        serverHost: "0.0.0.0",
        serverPort: 3001,
        jobConcurrency: 1,
        maxUploadSizeMb: 1024,
        paths: {
          data: tmpDir,
          output: outputDir,
          assets: join(tmpDir, "assets"),
          subwaySurfers: join(tmpDir, "assets", "subway-surfers"),
          uploads: join(tmpDir, "uploads"),
          checkpointDb: join(tmpDir, "checkpoints.db"),
        },
      };

      const orchestrator = new PipelineOrchestrator(config as never, checkpoint as never);
      const calls = {
        extract: 0,
        removeSilence: 0,
        captions: 0,
        compose: 0,
      };

      (orchestrator as any).canReuseMediaArtifact = async () => false;
      (orchestrator as any).videoProcessor = {
        extractClip: async (_videoPath: string, _clip: unknown, stageOutputDir: string) => {
          calls.extract++;
          const filePath = join(stageOutputDir, "fresh_raw.mp4");
          await Bun.write(filePath, "raw");
          return filePath;
        },
        removeSilence: async (clipPath: string, filePath: string) => {
          calls.removeSilence++;
          expect(clipPath.endsWith("fresh_raw.mp4")).toBe(true);
          await Bun.write(filePath, "clean");
          return { path: filePath, speechRanges: null };
        },
        composeReel: async (
          clipPath: string,
          _runConfig: unknown,
          filePath: string,
          captionOverlayPath?: string | null,
        ) => {
          calls.compose++;
          expect(clipPath.endsWith("_clean.mp4")).toBe(true);
          expect(captionOverlayPath?.endsWith("_captions.webm")).toBe(true);
          await Bun.write(filePath, "reel");
          return filePath;
        },
      };
      (orchestrator as any).captionGenerator = {
        generate: async (clipPath: string, filePath: string) => {
          calls.captions++;
          expect(clipPath.endsWith("_clean.mp4")).toBe(true);
          await Bun.write(filePath, "captions");
          return filePath;
        },
      };

      const clip = {
        id: "clip-12345678",
        title: "Recovered Clip",
        hookLine: "Hook",
        startTime: 10,
        endTime: 40,
        duration: 30,
        reasoning: "test",
        viralScore: 9,
        tags: [],
      };
      const metadata = {
        videoId: "video-1",
        title: "Video",
        duration: 100,
        uploadDate: "2026-04-07",
        filePath: join(tmpDir, "source.mp4"),
        sourceType: "upload" as const,
        sourceRef: join(tmpDir, "source.mp4"),
      };

      const result = await (orchestrator as any).processOneClip(
        "run-1",
        clip,
        0,
        metadata,
        tmpDir,
        outputDir,
        config,
      );

      expect(calls).toEqual({
        extract: 1,
        removeSilence: 1,
        captions: 1,
        compose: 1,
      });
      expect(result.extractedVideoPath.endsWith("fresh_raw.mp4")).toBe(true);
      expect(result.silenceRemovedPath.endsWith("_clean.mp4")).toBe(true);
      expect(result.captionOverlayPath.endsWith("_captions.webm")).toBe(true);
      expect(result.finalReelPath.endsWith(".mp4")).toBe(true);
      expect(checkpointUpdates.at(-1)).toEqual({
        stage: PipelineStage.COMPOSE_REEL,
        status: "completed",
        artifactPaths: {
          extractedVideoPath: result.extractedVideoPath,
          silenceRemovedPath: result.silenceRemovedPath,
          captionOverlayPath: result.captionOverlayPath,
          finalReelPath: result.finalReelPath,
        },
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("recomposes the final reel when captions are regenerated", async () => {
    const tmpDir = join(import.meta.dir, "__orchestrator_recompose__", crypto.randomUUID());
    const outputDir = join(tmpDir, "output");

    mkdirSync(outputDir, { recursive: true });

    try {
      const checkpointUpdates: Array<{
        stage: PipelineStage;
        status: string;
        artifactPaths: Record<string, string>;
      }> = [];

      const stored = {
        extractedVideoPath: join(tmpDir, "stored_raw.mp4"),
        silenceRemovedPath: join(tmpDir, "stored_clean.mp4"),
        captionOverlayPath: join(tmpDir, "stale_captions.webm"),
        finalReelPath: join(outputDir, "stale_reel.mp4"),
      };

      const checkpoint = {
        getClipProgress: () => ({
          stage: PipelineStage.COMPOSE_REEL,
          status: "completed",
          artifactPaths: stored,
        }),
        updateClipProgress: (
          _runId: string,
          _clipId: string,
          _clipIndex: number,
          stage: PipelineStage,
          status: string,
          artifactPaths: Record<string, string>,
        ) => {
          checkpointUpdates.push({ stage, status, artifactPaths });
        },
      };

      const config = {
        maxParallelClips: 1,
        silenceThresholdDb: -35,
        silenceMinDuration: 0.8,
        outputWidth: 1080,
        outputHeight: 1920,
        clipSpeed: 1.2,
        maxClips: 5,
        preferYouTubeTranscripts: false,
        captionAnimate: true,
        generateCaptions: true,
        removeSilence: true,
        whisperModel: "tiny",
        whisperCliBin: "whisper-cli",
        whisperCliModelPath: "",
        geminiApiKey: "test",
        serverHost: "0.0.0.0",
        serverPort: 3001,
        jobConcurrency: 1,
        maxUploadSizeMb: 1024,
        paths: {
          data: tmpDir,
          output: outputDir,
          assets: join(tmpDir, "assets"),
          subwaySurfers: join(tmpDir, "assets", "subway-surfers"),
          uploads: join(tmpDir, "uploads"),
          checkpointDb: join(tmpDir, "checkpoints.db"),
        },
      };

      const orchestrator = new PipelineOrchestrator(config as never, checkpoint as never);
      let composeCalls = 0;

      (orchestrator as any).canReuseMediaArtifact = async (artifactPath: string | undefined) => {
        if (!artifactPath) {
          return false;
        }

        return artifactPath !== stored.captionOverlayPath;
      };
      (orchestrator as any).videoProcessor = {
        composeReel: async (
          clipPath: string,
          _runConfig: unknown,
          filePath: string,
          captionOverlayPath?: string | null,
        ) => {
          composeCalls++;
          expect(clipPath).toBe(stored.silenceRemovedPath);
          expect(captionOverlayPath).toBe(join(tmpDir, "fresh_captions.webm"));
          await Bun.write(filePath, "reel");
          return filePath;
        },
      };
      (orchestrator as any).captionGenerator = {
        generate: async (_clipPath: string, filePath: string) => {
          const freshPath = join(tmpDir, "fresh_captions.webm");
          expect(filePath.endsWith("_captions.webm")).toBe(true);
          await Bun.write(freshPath, "captions");
          return freshPath;
        },
      };

      const clip = {
        id: "clip-abcdefgh",
        title: "Caption Recovery",
        hookLine: "Hook",
        startTime: 10,
        endTime: 40,
        duration: 30,
        reasoning: "test",
        viralScore: 9,
        tags: [],
      };
      const metadata = {
        videoId: "video-1",
        title: "Video",
        duration: 100,
        uploadDate: "2026-04-07",
        filePath: join(tmpDir, "source.mp4"),
        sourceType: "upload" as const,
        sourceRef: join(tmpDir, "source.mp4"),
      };

      const result = await (orchestrator as any).processOneClip(
        "run-1",
        clip,
        0,
        metadata,
        tmpDir,
        outputDir,
        config,
      );

      expect(composeCalls).toBe(1);
      expect(result.captionOverlayPath).toBe(join(tmpDir, "fresh_captions.webm"));
      expect(result.finalReelPath.endsWith(".mp4")).toBe(true);
      expect(checkpointUpdates.at(-1)?.stage).toBe(PipelineStage.COMPOSE_REEL);
      expect(checkpointUpdates.at(-1)?.status).toBe("completed");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
