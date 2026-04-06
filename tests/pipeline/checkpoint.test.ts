import { describe, test, expect, afterEach } from "bun:test";
import { rmSync, existsSync } from "fs";
import { join } from "path";
import { CheckpointManager } from "../../src/pipeline/checkpoint";
import { PipelineStage, StageStatus } from "../../src/pipeline/types";

const DB_PATH = join(import.meta.dir, "__test_checkpoint__.db");

function cleanDb() {
  for (const ext of ["", "-wal", "-shm"]) {
    const p = DB_PATH + ext;
    if (existsSync(p)) rmSync(p);
  }
}

afterEach(cleanDb);

describe("CheckpointManager", () => {
  test("creates a run and retrieves it", () => {
    const cm = new CheckpointManager(DB_PATH);
    const run = cm.createRun("youtube", "https://youtube.com/watch?v=abc", "abc", "Test Video");
    expect(run.id).toBeDefined();
    expect(run.videoUrl).toBe("https://youtube.com/watch?v=abc");
    expect(run.status).toBe("queued");

    const retrieved = cm.getRunInfo(run.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.sourceType).toBe("youtube");
    expect(retrieved!.sourceRef).toBe("https://youtube.com/watch?v=abc");
    expect(retrieved!.videoId).toBe("abc");
    expect(retrieved!.videoTitle).toBe("Test Video");
    cm.close();
  });

  test("getAllRuns returns all runs in desc order", () => {
    const cm = new CheckpointManager(DB_PATH);
    cm.createRun("youtube", "url1", "v1", "Video 1");
    cm.createRun("upload", "/tmp/url2.mp4", "v2", "Video 2");
    const runs = cm.getAllRuns();
    expect(runs.length).toBe(2);
    cm.close();
  });

  test("stage lifecycle: start → complete", () => {
    const cm = new CheckpointManager(DB_PATH);
    const run = cm.createRun("youtube", "url", "vid", "title");

    cm.startStage(run.id, PipelineStage.DOWNLOAD);
    let result = cm.getStageResult(run.id, PipelineStage.DOWNLOAD);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(StageStatus.IN_PROGRESS);

    const metadata = {
      videoId: "vid",
      title: "title",
      duration: 600,
      uploadDate: "2024-01-01",
      filePath: "/tmp/vid.mp4",
      sourceType: "upload" as const,
      sourceRef: "/tmp/vid.mp4",
    };
    cm.completeStage(run.id, PipelineStage.DOWNLOAD, ["/tmp/vid.mp4"], metadata);

    result = cm.getStageResult(run.id, PipelineStage.DOWNLOAD);
    expect(result!.status).toBe(StageStatus.COMPLETED);
    expect(result!.data).toEqual(metadata);
    expect(result!.artifactPaths).toEqual(["/tmp/vid.mp4"]);
    cm.close();
  });

  test("stage failure records error", () => {
    const cm = new CheckpointManager(DB_PATH);
    const run = cm.createRun("youtube", "url", "vid", "title");
    cm.startStage(run.id, PipelineStage.TRANSCRIBE);
    cm.failStage(run.id, PipelineStage.TRANSCRIBE, "whisper crashed");

    const result = cm.getStageResult(run.id, PipelineStage.TRANSCRIBE);
    expect(result!.status).toBe(StageStatus.FAILED);
    expect(result!.error).toBe("whisper crashed");
    cm.close();
  });

  test("getLastCompletedStage finds latest", () => {
    const cm = new CheckpointManager(DB_PATH);
    const run = cm.createRun("youtube", "url", "vid", "title");

    expect(cm.getLastCompletedStage(run.id)).toBeNull();

    cm.startStage(run.id, PipelineStage.DOWNLOAD);
    cm.completeStage(run.id, PipelineStage.DOWNLOAD, [], {});
    cm.startStage(run.id, PipelineStage.TRANSCRIBE);
    cm.completeStage(run.id, PipelineStage.TRANSCRIBE, [], {});

    expect(cm.getLastCompletedStage(run.id)).toBe(PipelineStage.TRANSCRIBE);
    cm.close();
  });

  test("clip progress tracking", () => {
    const cm = new CheckpointManager(DB_PATH);
    const run = cm.createRun("upload", "/tmp/video.mp4", "vid", "title");
    const clipId = "clip-001";

    cm.updateClipProgress(run.id, clipId, 0, PipelineStage.EXTRACT_CLIPS, "in_progress", {});
    let progress = cm.getClipProgress(run.id, clipId);
    expect(progress).not.toBeNull();
    expect(progress!.status).toBe("in_progress");

    cm.updateClipProgress(run.id, clipId, 0, PipelineStage.COMPOSE_REEL, "completed", {
      finalReelPath: "/output/reel.mp4",
    });
    progress = cm.getClipProgress(run.id, clipId);
    expect(progress!.status).toBe("completed");
    expect(progress!.artifactPaths.finalReelPath).toBe("/output/reel.mp4");

    expect(cm.getCompletedClipIds(run.id)).toEqual([clipId]);
    expect(cm.getIncompleteClipIds(run.id)).toEqual([]);
    cm.close();
  });

  test("markRunComplete and markRunFailed", () => {
    const cm = new CheckpointManager(DB_PATH);
    const run = cm.createRun("youtube", "url", "vid", "title");

    cm.markRunComplete(run.id);
    expect(cm.getRunInfo(run.id)!.status).toBe("completed");

    const run2 = cm.createRun("upload", "/tmp/url2.mp4", "vid2", "title2");
    cm.markRunFailed(run2.id);
    expect(cm.getRunInfo(run2.id)!.status).toBe("failed");
    cm.close();
  });

  test("getRunInfo returns null for non-existent run", () => {
    const cm = new CheckpointManager(DB_PATH);
    expect(cm.getRunInfo("non-existent-id")).toBeNull();
    cm.close();
  });

  test("markRunRunning and updateRunMetadata mutate run details", () => {
    const cm = new CheckpointManager(DB_PATH);
    const run = cm.createRun("upload", "/tmp/source.mp4", "initial", "");

    cm.markRunRunning(run.id);
    cm.updateRunMetadata(run.id, "final-id", "Final Title");

    const updated = cm.getRunInfo(run.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("running");
    expect(updated!.videoId).toBe("final-id");
    expect(updated!.videoTitle).toBe("Final Title");
    cm.close();
  });
});
