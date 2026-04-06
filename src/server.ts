import { relative, resolve, sep } from "path";

import type { Config } from "./config";
import { CheckpointManager } from "./pipeline/checkpoint";
import { PipelineStage, type ClipCandidate, type PipelineInput } from "./pipeline/types";
import { PipelineOrchestrator } from "./pipeline/orchestrator";
import { ensureDir, sanitizeFileName } from "./utils/fs";
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
  const clipStageResult = checkpoint.getStageResult<ClipCandidate[]>(runId, PipelineStage.IDENTIFY_CLIPS);
  const clipMap = new Map((clipStageResult?.data ?? []).map((clip) => [clip.id, clip]));
  const outputs = clipProgress
    .filter((entry) => Boolean(entry.artifactPaths.finalReelPath))
    .map((entry) => ({
      clipId: entry.clipId,
      title: clipMap.get(entry.clipId)?.title ?? entry.clipId,
      path: entry.artifactPaths.finalReelPath,
      url: buildMediaUrl(entry.artifactPaths.finalReelPath, config),
    }));

  return {
    ...run,
    stages: stageResults,
    clips: clipProgress.map((entry) => ({
      ...entry,
      title: clipMap.get(entry.clipId)?.title ?? entry.clipId,
    })),
    outputs,
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

        if (request.method === "GET" && path === "/api/jobs") {
          const runs = checkpoint.getAllRuns().map((run) => summarizeRun(run.id, checkpoint, config));
          return json({
            queue: queue.getStats(),
            runs,
          });
        }

        if (request.method === "GET" && path.startsWith("/api/jobs/")) {
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

          queue.enqueue(async () => {
            await orchestrator.executeRunById(runId, input, {
              generateCaptions: normalizeBoolean(form.get("generateCaptions"), config.generateCaptions),
              maxClips: normalizeNumber(form.get("maxClips")),
              removeSilence: normalizeBoolean(form.get("removeSilence"), config.removeSilence),
            });
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
