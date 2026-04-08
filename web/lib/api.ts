import type {
  CleanupRunResponse,
  CreateRunResponse,
  DashboardResponse,
  LocalDownloadRequest,
  LocalDownloadResponse,
  RunDetailResponse,
} from "./types";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:3001";

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error || `Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function fetchDashboard(): Promise<DashboardResponse> {
  const response = await fetch(`${apiBaseUrl}/api/jobs`, {
    cache: "no-store",
  });
  return await parseJson<DashboardResponse>(response);
}

export async function fetchRun(runId: string): Promise<RunDetailResponse> {
  const response = await fetch(`${apiBaseUrl}/api/jobs/${runId}`, {
    cache: "no-store",
  });
  return await parseJson<RunDetailResponse>(response);
}

export async function createRun(formData: FormData): Promise<CreateRunResponse> {
  const response = await fetch(`${apiBaseUrl}/api/jobs`, {
    method: "POST",
    body: formData,
  });
  return await parseJson<CreateRunResponse>(response);
}

export async function cleanupRun(runId: string): Promise<CleanupRunResponse> {
  const response = await fetch(`${apiBaseUrl}/api/jobs/${runId}/cleanup`, {
    method: "POST",
  });
  return await parseJson<CleanupRunResponse>(response);
}

export async function createRunFromYouTube(
  payload: LocalDownloadRequest,
): Promise<LocalDownloadResponse> {
  const response = await fetch("/api/local-download", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return await parseJson<LocalDownloadResponse>(response);
}

export function resolveApiUrl(path: string): string {
  return `${apiBaseUrl}${path}`;
}

export function resolveMediaUrl(path: string): string {
  return resolveApiUrl(path);
}
