import { basename } from "path";
import { join } from "path";

import type { Config } from "../config";
import { CaptionGenerator } from "../modules/caption-generator";
import { ClipIdentifier } from "../modules/clip-identifier";
import { InputResolver } from "../modules/input-resolver";
import { Transcriber } from "../modules/transcriber";
import { VideoProcessor } from "../modules/video-processor";
import { buildClipOutputFileName, ensureDir, runDir, slugify } from "../utils/fs";
import { createLogger } from "../utils/logger";
import { CheckpointManager } from "./checkpoint";
import { PipelineStage, type PipelineInput, type ClipArtifacts, type ClipCandidate, type Transcript, type VideoMetadata } from "./types";

const log = createLogger("orchestrator");

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
      const next = this.queue.shift();
      next?.();
      return;
    }

    this.count++;
  }
}

export interface PipelineRunOptions {
  generateCaptions?: boolean;
  maxClips?: number;
  removeSilence?: boolean;
}

type EffectiveRunConfig = Config & Required<PipelineRunOptions>;

export class PipelineOrchestrator {
  private checkpoint: CheckpointManager;
  private config: Config;
  private inputResolver = new InputResolver();
  private transcriber = new Transcriber();
  private clipIdentifier: ClipIdentifier;
  private videoProcessor = new VideoProcessor();
  private captionGenerator = new CaptionGenerator();

  constructor(config: Config, checkpoint: CheckpointManager) {
    this.config = config;
    this.checkpoint = checkpoint;
    this.clipIdentifier = new ClipIdentifier(config);
  }

  async run(videoUrl: string): Promise<string> {
    return await this.runInput({ type: "youtube", url: videoUrl });
  }

  async runFile(filePath: string, title?: string): Promise<string> {
    return await this.runInput({
      type: "file",
      filePath,
      title,
      originalFileName: basename(filePath),
    });
  }

  async runInput(input: PipelineInput, options?: PipelineRunOptions): Promise<string> {
    const runId = this.createRunRecord(input);
    await this.executeRunById(runId, input, options);
    return runId;
  }

  createRunRecord(input: PipelineInput): string {
    const sourceType = input.type === "youtube" ? "youtube" : "upload";
    const sourceRef = input.type === "youtube" ? input.url : input.filePath;
    const videoId = this.extractInputId(input);
    const videoTitle = input.type === "file" ? input.title?.trim() || basename(input.filePath) : "";
    const run = this.checkpoint.createRun(sourceType, sourceRef, videoId, videoTitle);
    return run.id;
  }

  async executeRunById(
    runId: string,
    input: PipelineInput,
    options?: PipelineRunOptions,
  ): Promise<void> {
    const runConfig = this.buildRunConfig(options);
    const dir = runDir(runConfig.paths.data, runId);

    log.info(`Pipeline started: ${runId}`);
    log.info(`Source: ${input.type === "youtube" ? input.url : input.filePath}`);

    this.checkpoint.markRunRunning(runId);

    try {
      const metadata = await this.stageDownload(runId, input, dir);
      this.checkpoint.updateRunMetadata(runId, metadata.videoId, metadata.title);

      const transcript = await this.stageTranscribe(runId, metadata, dir, runConfig);
      let clips = await this.stageIdentifyClips(runId, transcript, metadata, dir);

      if (runConfig.maxClips > 0) {
        clips = clips.slice(0, runConfig.maxClips);
        log.info(`Limiting to ${clips.length} clips (maxClips=${runConfig.maxClips})`);
      }

      await this.processClips(runId, clips, metadata, dir, runConfig);
      this.checkpoint.markRunComplete(runId);
      log.info(`Pipeline completed: ${runId}`);
    } catch (err) {
      log.error(`Pipeline failed: ${err}`);
      this.checkpoint.markRunFailed(runId);
      throw err;
    }
  }

  async resume(runId: string): Promise<void> {
    const run = this.checkpoint.getRunInfo(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    const input: PipelineInput =
      run.sourceType === "youtube"
        ? { type: "youtube", url: run.sourceRef }
        : {
            type: "file",
            filePath: run.sourceRef,
            title: run.videoTitle || undefined,
            originalFileName: basename(run.sourceRef),
          };

    const runConfig = this.buildRunConfig();
    const dir = runDir(runConfig.paths.data, runId);

    log.info(`Resuming pipeline: ${runId}`);
    this.checkpoint.markRunRunning(runId);

    try {
      let metadata: VideoMetadata;
      const downloadResult = this.checkpoint.getStageResult<VideoMetadata>(runId, PipelineStage.DOWNLOAD);
      if (downloadResult?.status === "completed") {
        metadata = downloadResult.data;
        log.info("Skipping DOWNLOAD (completed)");
      } else {
        metadata = await this.stageDownload(runId, input, dir);
      }

      let transcript: Transcript;
      const transcriptResult = this.checkpoint.getStageResult<Transcript>(runId, PipelineStage.TRANSCRIBE);
      if (transcriptResult?.status === "completed") {
        transcript = transcriptResult.data;
        log.info("Skipping TRANSCRIBE (completed)");
      } else {
        transcript = await this.stageTranscribe(runId, metadata, dir, runConfig);
      }

      let clips: ClipCandidate[];
      const clipResult = this.checkpoint.getStageResult<ClipCandidate[]>(
        runId,
        PipelineStage.IDENTIFY_CLIPS,
      );
      if (clipResult?.status === "completed") {
        clips = clipResult.data;
        log.info("Skipping IDENTIFY_CLIPS (completed)");
      } else {
        clips = await this.stageIdentifyClips(runId, transcript, metadata, dir);
      }

      const completedIds = new Set(this.checkpoint.getCompletedClipIds(runId));
      const remainingClips = clips.filter((clip) => !completedIds.has(clip.id));

      if (remainingClips.length === 0) {
        log.info("All clips already processed");
      } else {
        log.info(`Resuming ${remainingClips.length}/${clips.length} clips`);
        await this.processClips(runId, remainingClips, metadata, dir, runConfig);
      }

      this.checkpoint.markRunComplete(runId);
      log.info(`Pipeline resumed and completed: ${runId}`);
    } catch (err) {
      log.error(`Resume failed: ${err}`);
      this.checkpoint.markRunFailed(runId);
      throw err;
    }
  }

  private buildRunConfig(options?: PipelineRunOptions): EffectiveRunConfig {
    return {
      ...this.config,
      generateCaptions: options?.generateCaptions ?? this.config.generateCaptions,
      maxClips: options?.maxClips ?? this.config.maxClips,
      removeSilence: options?.removeSilence ?? this.config.removeSilence,
    };
  }

  private async stageDownload(
    runId: string,
    input: PipelineInput,
    dir: string,
  ): Promise<VideoMetadata> {
    this.checkpoint.startStage(runId, PipelineStage.DOWNLOAD);
    const downloadDir = join(dir, "downloads");
    const metadata = await this.inputResolver.resolve(input, downloadDir);
    this.checkpoint.completeStage(runId, PipelineStage.DOWNLOAD, [metadata.filePath], metadata);
    return metadata;
  }

  private async stageTranscribe(
    runId: string,
    metadata: VideoMetadata,
    dir: string,
    config: Config,
  ): Promise<Transcript> {
    this.checkpoint.startStage(runId, PipelineStage.TRANSCRIBE);
    const transcriptDir = join(dir, "transcripts");
    const transcript = await this.transcriber.transcribe(metadata, transcriptDir, config);
    this.checkpoint.completeStage(
      runId,
      PipelineStage.TRANSCRIBE,
      transcript.srtPath ? [transcript.srtPath] : [],
      transcript,
    );
    return transcript;
  }

  private async stageIdentifyClips(
    runId: string,
    transcript: Transcript,
    metadata: VideoMetadata,
    dir: string,
  ): Promise<ClipCandidate[]> {
    this.checkpoint.startStage(runId, PipelineStage.IDENTIFY_CLIPS);
    const clips = await this.clipIdentifier.identify(transcript, metadata);
    const clipsPath = join(dir, "clips.json");
    await Bun.write(clipsPath, JSON.stringify(clips, null, 2));
    this.checkpoint.completeStage(runId, PipelineStage.IDENTIFY_CLIPS, [clipsPath], clips);
    log.info(`Identified ${clips.length} clips`);
    return clips;
  }

  private async processClips(
    runId: string,
    clips: ClipCandidate[],
    metadata: VideoMetadata,
    dir: string,
    config: EffectiveRunConfig,
  ): Promise<void> {
    const semaphore = new Semaphore(config.maxParallelClips);
    const outputDir = join(config.paths.output, metadata.videoId);
    ensureDir(outputDir);

    if (config.generateCaptions) {
      await this.captionGenerator.warmup();
    }

    log.info(`Processing ${clips.length} clips (parallel: ${config.maxParallelClips})`);

    const results = await Promise.allSettled(
      clips.map(async (clip, index) => {
        await semaphore.acquire();

        try {
          log.info(`[${index + 1}/${clips.length}] Processing: "${clip.title}"`);
          await this.processOneClip(runId, clip, index, metadata, dir, outputDir, config);
          log.info(`[${index + 1}/${clips.length}] Completed: "${clip.title}"`);
        } finally {
          semaphore.release();
        }
      }),
    );

    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length > 0) {
      log.warn(`${failed.length}/${clips.length} clips failed`);
      for (const result of failed) {
        if (result.status === "rejected") {
          log.error(`  ${result.reason}`);
        }
      }
    }

    const succeeded = results.filter((result) => result.status === "fulfilled").length;
    log.info(`${succeeded}/${clips.length} clips processed successfully`);

    if (failed.length > 0) {
      throw new Error(`Clip processing incomplete: ${failed.length}/${clips.length} clips failed`);
    }
  }

  private async processOneClip(
    runId: string,
    clip: ClipCandidate,
    clipIndex: number,
    metadata: VideoMetadata,
    dir: string,
    outputDir: string,
    config: EffectiveRunConfig,
  ): Promise<ClipArtifacts> {
    const artifacts: Partial<ClipArtifacts> = { clipId: clip.id };
    const progress = this.checkpoint.getClipProgress(runId, clip.id);

    if (progress?.artifactPaths?.extractedVideoPath) {
      artifacts.extractedVideoPath = progress.artifactPaths.extractedVideoPath;
    } else {
      this.checkpoint.updateClipProgress(
        runId,
        clip.id,
        clipIndex,
        PipelineStage.EXTRACT_CLIPS,
        "in_progress",
        {},
      );
      artifacts.extractedVideoPath = await this.videoProcessor.extractClip(
        metadata.filePath,
        clip,
        join(dir, "clips"),
      );
      this.checkpoint.updateClipProgress(
        runId,
        clip.id,
        clipIndex,
        PipelineStage.EXTRACT_CLIPS,
        "completed",
        { extractedVideoPath: artifacts.extractedVideoPath },
      );
    }

    if (progress?.artifactPaths?.silenceRemovedPath) {
      artifacts.silenceRemovedPath = progress.artifactPaths.silenceRemovedPath;
    } else if (!config.removeSilence) {
      artifacts.silenceRemovedPath = artifacts.extractedVideoPath;
      this.checkpoint.updateClipProgress(
        runId,
        clip.id,
        clipIndex,
        PipelineStage.REMOVE_SILENCE,
        "skipped",
        {
          extractedVideoPath: artifacts.extractedVideoPath,
          silenceRemovedPath: artifacts.silenceRemovedPath,
        },
      );
    } else {
      this.checkpoint.updateClipProgress(
        runId,
        clip.id,
        clipIndex,
        PipelineStage.REMOVE_SILENCE,
        "in_progress",
        { extractedVideoPath: artifacts.extractedVideoPath },
      );
      const desilencedPath = join(dir, "desilenced", `${clip.id}_clean.mp4`);
      const result = await this.videoProcessor.removeSilence(
        artifacts.extractedVideoPath,
        desilencedPath,
        config,
      );
      artifacts.silenceRemovedPath = result.path;
      this.checkpoint.updateClipProgress(
        runId,
        clip.id,
        clipIndex,
        PipelineStage.REMOVE_SILENCE,
        "completed",
        {
          extractedVideoPath: artifacts.extractedVideoPath,
          silenceRemovedPath: artifacts.silenceRemovedPath,
        },
      );
    }

    if (progress?.artifactPaths?.captionOverlayPath) {
      artifacts.captionOverlayPath = progress.artifactPaths.captionOverlayPath;
    } else if (!config.generateCaptions) {
      artifacts.captionOverlayPath = "";
      this.checkpoint.updateClipProgress(
        runId,
        clip.id,
        clipIndex,
        PipelineStage.GENERATE_CAPTIONS,
        "skipped",
        {
          extractedVideoPath: artifacts.extractedVideoPath,
          silenceRemovedPath: artifacts.silenceRemovedPath,
          captionOverlayPath: artifacts.captionOverlayPath,
        },
      );
    } else {
      this.checkpoint.updateClipProgress(
        runId,
        clip.id,
        clipIndex,
        PipelineStage.GENERATE_CAPTIONS,
        "in_progress",
        {
          extractedVideoPath: artifacts.extractedVideoPath,
          silenceRemovedPath: artifacts.silenceRemovedPath,
        },
      );

      const overlayPath = join(dir, "captions", `${clip.id}_captions.webm`);
      artifacts.captionOverlayPath = await this.captionGenerator.generate(
        artifacts.silenceRemovedPath,
        overlayPath,
        config,
      );

      this.checkpoint.updateClipProgress(
        runId,
        clip.id,
        clipIndex,
        PipelineStage.GENERATE_CAPTIONS,
        "completed",
        {
          extractedVideoPath: artifacts.extractedVideoPath,
          silenceRemovedPath: artifacts.silenceRemovedPath,
          captionOverlayPath: artifacts.captionOverlayPath,
        },
      );
    }

    if (progress?.artifactPaths?.finalReelPath) {
      artifacts.finalReelPath = progress.artifactPaths.finalReelPath;
    } else {
      this.checkpoint.updateClipProgress(
        runId,
        clip.id,
        clipIndex,
        PipelineStage.COMPOSE_REEL,
        "in_progress",
        {
          extractedVideoPath: artifacts.extractedVideoPath,
          silenceRemovedPath: artifacts.silenceRemovedPath,
          captionOverlayPath: artifacts.captionOverlayPath,
        },
      );
      const reelPath = join(outputDir, buildClipOutputFileName(clip.title, clip.id, clipIndex));
      artifacts.finalReelPath = await this.videoProcessor.composeReel(
        artifacts.silenceRemovedPath,
        config,
        reelPath,
        artifacts.captionOverlayPath || null,
      );
      this.checkpoint.updateClipProgress(
        runId,
        clip.id,
        clipIndex,
        PipelineStage.COMPOSE_REEL,
        "completed",
        {
          extractedVideoPath: artifacts.extractedVideoPath,
          silenceRemovedPath: artifacts.silenceRemovedPath,
          captionOverlayPath: artifacts.captionOverlayPath || "",
          finalReelPath: artifacts.finalReelPath,
        },
      );
    }

    return artifacts as ClipArtifacts;
  }

  private extractInputId(input: PipelineInput): string {
    if (input.type === "youtube") {
      return extractVideoId(input.url);
    }

    const raw = input.title?.trim() || basename(input.filePath);
    return `${slugify(raw)}-${crypto.randomUUID().slice(0, 8)}`;
  }
}

export function extractVideoId(url: string): string {
  const match = url.match(/(?:v=|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match?.[1] ?? url.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 32);
}
