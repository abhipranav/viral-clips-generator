import { basename, dirname, join } from "path";
import { existsSync, renameSync } from "fs";

import { buildClipOutputFileName } from "../utils/fs";
import { CheckpointManager } from "./checkpoint";
import type { ClipCandidate } from "./types";
import type { ClipProgressEntry } from "./run-health";

export function getDesiredFinalReelPath(
  currentPath: string,
  clip: ClipCandidate,
  clipIndex: number,
): string {
  return join(dirname(currentPath), buildClipOutputFileName(clip.title, clip.id, clipIndex));
}

export function migrateLegacyFinalReelPath(params: {
  runId: string;
  checkpoint: CheckpointManager;
  clip: ClipCandidate;
  progress: ClipProgressEntry;
}): string {
  const { runId, checkpoint, clip, progress } = params;
  const currentPath = progress.artifactPaths.finalReelPath;

  if (!currentPath) {
    return currentPath;
  }

  const desiredPath = getDesiredFinalReelPath(currentPath, clip, progress.clipIndex);
  if (currentPath === desiredPath) {
    return currentPath;
  }

  if (!existsSync(currentPath)) {
    return currentPath;
  }

  if (!existsSync(desiredPath)) {
    renameSync(currentPath, desiredPath);
  }

  checkpoint.updateClipArtifactPaths(runId, progress.clipId, {
    ...progress.artifactPaths,
    finalReelPath: desiredPath,
  });

  return desiredPath;
}

export function isLegacyFinalReelName(filePath: string): boolean {
  return /[a-f0-9-]{8,}_reel\.mp4$/i.test(basename(filePath));
}
