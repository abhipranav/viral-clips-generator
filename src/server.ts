import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, join, relative, resolve, sep } from "path";

import type { Config } from "./config";
import { CheckpointManager } from "./pipeline/checkpoint";
import { migrateLegacyFinalReelPath } from "./pipeline/output-names";
import { deriveRunState } from "./pipeline/run-health";
import { PipelineStage, type ClipCandidate, type PipelineInput } from "./pipeline/types";
import { PipelineOrchestrator } from "./pipeline/orchestrator";
import { cleanRunArtifacts, ensureDir, sanitizeFileName } from "./utils/fs";
import { createLogger } from "./utils/logger";

const log = createLogger("api");

class PipelineJobQueue {
  private concurrency: number;
  private pending: Array<() => Promise<void>> = [];
  private running = 0;

  constructor(concurrency: number) {
    this.concurrency = concurrency;
  }

  enqueue(task: () => Promise<void>): void {
    this.pending.push(task);
    this.drain();
  }

  getStats(): { pending: number; running: number; concurrency: number } {
    return {
      pending: this.pending.length,
      running: this.running,
      concurrency: this.concurrency,
    };
  }

  private drain(): void {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift();
      if (!task) {
        return;
      }

      this.running++;
      task()
        .catch((err) => {
          log.error(`Queued job failed: ${err}`);
        })
        .finally(() => {
          this.running--;
          this.drain();
        });
    }
  }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    },
  });
}

function textError(message: string, status: number): Response {
  return json({ error: message }, status);
}

function normalizeBoolean(value: FormDataEntryValue | null, fallback: boolean): boolean {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  return normalized === "true" || normalized === "1" || normalized === "on";
}

function normalizeNumber(value: FormDataEntryValue | null): number | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function withinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function buildMediaUrl(filePath: string, config: Config): string | null {
  const roots = [
    { key: "output", value: resolve(config.paths.output) },
    { key: "data", value: resolve(config.paths.data) },
    { key: "uploads", value: resolve(config.paths.uploads) },
  ];
  const absolute = resolve(filePath);

  for (const root of roots) {
    if (!withinRoot(absolute, root.value)) {
      continue;
    }

    const rel = relative(root.value, absolute).split(sep).join("/");
    return `/media/${root.key}/${rel}`;
  }

  return null;
}

function resolveMediaPath(rootKey: string, rest: string, config: Config): string | null {
  const roots: Record<string, string> = {
    output: resolve(config.paths.output),
    data: resolve(config.paths.data),
    uploads: resolve(config.paths.uploads),
  };
  const root = roots[rootKey];
  if (!root) {
    return null;
  }

  const candidate = resolve(root, rest);
  if (!withinRoot(candidate, root)) {
    return null;
  }

  return candidate;
}

function cleanupRunStorage(runId: string, checkpoint: CheckpointManager, config: Config): {
  removedUploadSource: boolean;
  removedIntermediateArtifacts: boolean;
} {
  const run = checkpoint.getRunInfo(runId);
  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  cleanRunArtifacts(config.paths.data, runId, true);

  let removedUploadSource = false;
  if (run.sourceType === "upload") {
    const uploadRoot = resolve(config.paths.uploads);
    const sourcePath = resolve(run.sourceRef);
    if (withinRoot(sourcePath, uploadRoot) && existsSync(sourcePath)) {
      rmSync(sourcePath, { force: true });
      removedUploadSource = true;
    }
  }

  return {
    removedUploadSource,
    removedIntermediateArtifacts: true,
  };
}

function summarizeRun(
  runId: string,
  checkpoint: CheckpointManager,
  config: Config,
): Record<string, unknown> {
  const run = checkpoint.getRunInfo(runId);
  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  const stageResults = checkpoint.getStageResultsForRun(runId);
  const clipProgress = checkpoint.getClipProgressEntries(runId);
  const clipStageResult = checkpoint.getStageResult<ClipCandidate[]>(
    runId,
    PipelineStage.IDENTIFY_CLIPS,
  );
  const clipCandidates = Array.isArray(clipStageResult?.data) ? clipStageResult.data : [];
  const clipMap = new Map(clipCandidates.map((clip) => [clip.id, clip]));
  const derived = deriveRunState({
    run,
    stageResults,
    clipProgress,
    clipCandidates,
  });
  const outputs = getRunOutputs(runId, checkpoint, config, clipProgress, clipMap);

  return {
    ...run,
    status: derived.status,
    currentStage: derived.currentStage,
    persistedStatus: derived.persistedStatus,
    stages: stageResults,
    clips: clipProgress.map((entry) => ({
      ...entry,
      title: clipMap.get(entry.clipId)?.title ?? entry.clipId,
    })),
    outputs,
  };
}

function getRunOutputs(
  runId: string,
  checkpoint: CheckpointManager,
  config: Config,
  clipProgress?: ReturnType<CheckpointManager["getClipProgressEntries"]>,
  clipMap?: Map<string, ClipCandidate>,
): Array<{ clipId: string; title: string; path: string; url: string | null }> {
  const run = checkpoint.getRunInfo(runId);
  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  const progressEntries = clipProgress ?? checkpoint.getClipProgressEntries(runId);
  let clipsById = clipMap;
  if (!clipsById) {
    const clipStageResult = checkpoint.getStageResult<ClipCandidate[]>(
      runId,
      PipelineStage.IDENTIFY_CLIPS,
    );
    const clipCandidates = Array.isArray(clipStageResult?.data) ? clipStageResult.data : [];
    clipsById = new Map(clipCandidates.map((clip) => [clip.id, clip]));
  }

  return progressEntries
    .filter((entry) => Boolean(entry.artifactPaths.finalReelPath))
    .map((entry) => {
      const clip = clipsById.get(entry.clipId);
      const finalPath = clip
        ? migrateLegacyFinalReelPath({
            runId,
            checkpoint,
            clip,
            progress: entry,
          })
        : entry.artifactPaths.finalReelPath;

      return {
        clipId: entry.clipId,
        title: clip?.title ?? entry.clipId,
        path: finalPath,
        url: buildMediaUrl(finalPath, config),
      };
    });
}

async function buildRunArchive(
  runId: string,
  checkpoint: CheckpointManager,
  config: Config,
): Promise<{ filePath: string; fileName: string }> {
  const run = checkpoint.getRunInfo(runId);
  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  const outputs = getRunOutputs(runId, checkpoint, config).filter((output) => existsSync(output.path));
  if (outputs.length === 0) {
    throw new Error("This run has no completed MP4 clips to archive yet.");
  }

  const archiveDir = mkdtempSync(join(tmpdir(), "jiang-clips-archive-"));
  const archiveName = sanitizeFileName(`${run.videoTitle || run.videoId || run.id}.zip`);
  const archivePath = join(archiveDir, archiveName);
  const pairs = outputs.map((output) => `${output.path}::${basename(output.path)}`);
  const script = `
import sys
import zipfile

archive_path = sys.argv[1]
pairs = sys.argv[2:]

with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
    for pair in pairs:
        source, arcname = pair.split("::", 1)
        bundle.write(source, arcname=arcname)
`;

  const proc = Bun.spawn(["python3", "-c", script, archivePath, ...pairs], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0 || !existsSync(archivePath)) {
    rmSync(archiveDir, { recursive: true, force: true });
    throw new Error(`Failed to build run archive: ${stderr || `python exited with code ${exitCode}`}`);
  }

  setTimeout(() => {
    rmSync(archiveDir, { recursive: true, force: true });
  }, 5 * 60 * 1000);

  return {
    filePath: archivePath,
    fileName: archiveName,
  };
}

export function startApiServer(config: Config): void {
  ensureDir(config.paths.data);
  ensureDir(config.paths.output);
  ensureDir(config.paths.uploads);

  const startedAt = new Date().toISOString();

  const checkpoint = new CheckpointManager(config.paths.checkpointDb);
  const orchestrator = new PipelineOrchestrator(config, checkpoint);
  const queue = new PipelineJobQueue(config.jobConcurrency);

  Bun.serve({
    hostname: config.serverHost,
    port: config.serverPort,
    fetch: async (request) => {
      if (request.method === "OPTIONS") {
        return json({ ok: true });
      }

      const url = new URL(request.url);
      const path = url.pathname;

      try {
        if (request.method === "GET" && path === "/health") {
          return json({
            ok: true,
            startedAt,
            uptimeSeconds: Math.floor(process.uptime()),
            queue: queue.getStats(),
            whisperModel: config.whisperModel,
            maxParallelClips: config.maxParallelClips,
          });
        }

        if (request.method === "GET" && path === "/readyz") {
          try {
            checkpoint.getAllRuns();
            return json({
              ok: true,
              checkpointDb: config.paths.checkpointDb,
            });
          } catch (err) {
            return json(
              {
                ok: false,
                error: err instanceof Error ? err.message : "Checkpoint readiness check failed.",
              },
              503,
            );
          }
        }

        if (request.method === "GET" && path === "/api/jobs") {
          const runs = checkpoint.getAllRuns().map((run) => summarizeRun(run.id, checkpoint, config));
          return json({
            queue: queue.getStats(),
            runs,
          });
        }

        if (request.method === "GET" && path.startsWith("/api/jobs/")) {
          if (path.endsWith("/download")) {
            const runId = path.replace("/api/jobs/", "").replace("/download", "");
            const archive = await buildRunArchive(runId, checkpoint, config);

            return new Response(Bun.file(archive.filePath), {
              headers: {
                "Access-Control-Allow-Origin": "*",
                "Content-Disposition": `attachment; filename="${archive.fileName}"`,
                "Content-Type": "application/zip",
              },
            });
          }

          if (path.endsWith("/cleanup")) {
            return textError("Not found", 404);
          }

          const runId = path.replace("/api/jobs/", "");
          const run = checkpoint.getRunInfo(runId);
          if (!run) {
            return textError("Run not found", 404);
          }

          return json({
            queue: queue.getStats(),
            run: summarizeRun(runId, checkpoint, config),
          });
        }

        if (request.method === "POST" && path === "/api/jobs") {
          const form = await request.formData();
          const file = form.get("video");

          if (!(file instanceof File)) {
            return textError("Field 'video' must be a file upload", 400);
          }

          if (file.size > config.maxUploadSizeMb * 1024 * 1024) {
            return textError(
              `File is too large. Maximum upload size is ${config.maxUploadSizeMb} MB.`,
              413,
            );
          }

          const safeName = `${Date.now()}-${sanitizeFileName(file.name || "upload.mp4")}`;
          const uploadPath = resolve(config.paths.uploads, safeName);
          await Bun.write(uploadPath, file);

          const title = typeof form.get("title") === "string" ? String(form.get("title")).trim() : undefined;
          const input: PipelineInput = {
            type: "file",
            filePath: uploadPath,
            title,
            originalFileName: file.name || safeName,
          };
          const runId = orchestrator.createRunRecord(input);
          const runOptions = {
            generateCaptions: normalizeBoolean(form.get("generateCaptions"), config.generateCaptions),
            maxClips: normalizeNumber(form.get("maxClips")),
            removeSilence: normalizeBoolean(form.get("removeSilence"), config.removeSilence),
          };

          log.info(
            `Queued upload job ${runId} (captions=${runOptions.generateCaptions}, removeSilence=${runOptions.removeSilence}, maxClips=${runOptions.maxClips ?? config.maxClips})`,
          );

          queue.enqueue(async () => {
            await orchestrator.executeRunById(runId, input, runOptions);
          });

          return json(
            {
              ok: true,
              runId,
              queue: queue.getStats(),
              input: {
                title: title || file.name,
                fileName: file.name,
                storedPath: uploadPath,
              },
            },
            202,
          );
        }

        if (request.method === "POST" && path.startsWith("/api/jobs/") && path.endsWith("/cleanup")) {
          const runId = path.replace("/api/jobs/", "").replace("/cleanup", "");
          const run = checkpoint.getRunInfo(runId);
          if (!run) {
            return textError("Run not found", 404);
          }

          const result = cleanupRunStorage(runId, checkpoint, config);
          return json({
            ok: true,
            runId,
            ...result,
          });
        }

        if (request.method === "GET" && path.startsWith("/media/")) {
          const [, , rootKey, ...rest] = path.split("/");
          const mediaPath = resolveMediaPath(rootKey, rest.join("/"), config);
          if (!mediaPath) {
            return textError("File not found", 404);
          }

          const file = Bun.file(mediaPath);
          if (!(await file.exists())) {
            return textError("File not found", 404);
          }

          if (url.searchParams.get("download") === "1") {
            return new Response(file, {
              headers: {
                "Content-Disposition": `attachment; filename="${basename(mediaPath)}"`,
              },
            });
          }

          return new Response(file);
        }

        return textError("Not found", 404);
      } catch (err) {
        log.error(`API request failed: ${err}`);
        return textError(`Request failed: ${err}`, 500);
      }
    },
  });

  log.info(`API listening on http://${config.serverHost}:${config.serverPort}`);
}
