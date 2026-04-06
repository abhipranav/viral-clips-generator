export interface QueueStats {
  pending: number;
  running: number;
  concurrency: number;
}

export interface RunStage {
  stage: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  artifactPaths: string[];
  error: string | null;
}

export interface RunClip {
  clipId: string;
  clipIndex: number;
  stage: string;
  status: string;
  title: string;
  updatedAt: string;
  artifactPaths: Record<string, string>;
}

export interface RunOutput {
  clipId: string;
  title: string;
  path: string;
  url: string | null;
}

export interface RunRecord {
  id: string;
  sourceType: "youtube" | "upload";
  sourceRef: string;
  videoUrl: string;
  videoId: string;
  videoTitle: string;
  createdAt: string;
  updatedAt: string;
  currentStage: string;
  status: "queued" | "running" | "paused" | "completed" | "failed";
  stages: RunStage[];
  clips: RunClip[];
  outputs: RunOutput[];
}

export interface DashboardResponse {
  queue: QueueStats;
  runs: RunRecord[];
}

export interface RunDetailResponse {
  queue: QueueStats;
  run: RunRecord;
}

export interface CreateRunResponse {
  ok: boolean;
  runId: string;
  queue: QueueStats;
}
