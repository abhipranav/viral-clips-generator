import { PipelineStage, type ClipCandidate, type PipelineRun, type StageResult } from "./types";

export interface ClipProgressEntry {
  clipId: string;
  clipIndex: number;
  stage: PipelineStage;
  status: string;
  artifactPaths: Record<string, string>;
  updatedAt: string;
}

export interface DerivedRunState {
  status: PipelineRun["status"];
  currentStage: PipelineStage;
  persistedStatus: PipelineRun["status"];
}

export function deriveRunState(params: {
  run: PipelineRun;
  stageResults: StageResult[];
  clipProgress: ClipProgressEntry[];
  clipCandidates: ClipCandidate[];
}): DerivedRunState {
  const { run, clipProgress, clipCandidates } = params;
  const persistedStatus = run.status;

  if (persistedStatus === "completed") {
    const incompleteClip = [...clipProgress]
      .sort((left, right) => right.clipIndex - left.clipIndex)
      .find((entry) => entry.status !== "completed");

    const completedClipCount = clipProgress.filter((entry) => entry.status === "completed").length;
    const identifiedClipCount = clipCandidates.length;
    const isClipWorkIncomplete =
      Boolean(incompleteClip) ||
      (identifiedClipCount > 0 && completedClipCount < identifiedClipCount);

    if (isClipWorkIncomplete) {
      return {
        status: "incomplete",
        currentStage: incompleteClip?.stage ?? run.currentStage,
        persistedStatus,
      };
    }
  }

  return {
    status: persistedStatus,
    currentStage: run.currentStage,
    persistedStatus,
  };
}
