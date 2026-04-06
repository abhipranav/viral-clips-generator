import { statSync } from "fs";
import { basename, extname, join } from "path";

import { Downloader } from "./downloader";
import type { PipelineInput, VideoMetadata } from "../pipeline/types";
import { ensureDir, fileExists, slugify } from "../utils/fs";
import { createLogger } from "../utils/logger";
import { runFfprobe } from "../utils/ffmpeg";

const log = createLogger("input-resolver");

export class InputResolver {
  private downloader = new Downloader();

  async resolve(input: PipelineInput, outputDir: string): Promise<VideoMetadata> {
    if (input.type === "youtube") {
      return await this.downloader.download(input.url, outputDir);
    }

    return await this.fromLocalFile(input, outputDir);
  }

  private async fromLocalFile(
    input: Extract<PipelineInput, { type: "file" }>,
    outputDir: string,
  ): Promise<VideoMetadata> {
    if (!(await fileExists(input.filePath))) {
      throw new Error(`Uploaded video file not found: ${input.filePath}`);
    }

    ensureDir(outputDir);

    const probe = await runFfprobe(input.filePath);
    const stats = statSync(input.filePath);
    const originalName = input.originalFileName ?? basename(input.filePath);
    const fallbackTitle = basename(originalName, extname(originalName));
    const title = input.title?.trim() || fallbackTitle;
    const stableBase = slugify(title || fallbackTitle);
    const videoId = `${stableBase}-${crypto.randomUUID().slice(0, 8)}`;
    const markerPath = join(outputDir, `${videoId}.upload.txt`);

    await Bun.write(markerPath, input.filePath);

    log.info(`Using uploaded source file: ${originalName}`);

    return {
      videoId,
      title,
      duration: probe.duration,
      uploadDate: stats.mtime.toISOString(),
      filePath: input.filePath,
      sourceType: "upload",
      sourceRef: input.filePath,
      originalFileName: originalName,
    };
  }
}
