import { mkdtemp, readdir, readFile, rm, stat } from "fs/promises";
import os from "os";
import path from "path";
import { spawn } from "child_process";

import type { LocalDownloadRequest, LocalDownloadResponse } from "../../../lib/types";

export const runtime = "nodejs";

const ytDlpBin = process.env.YT_DLP_BIN || "yt-dlp";
const outputApiUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:3001";
const localDownloadsEnabled = process.env.LOCAL_YTDLP_ENABLED === "true";
const localDownloadDir = process.env.LOCAL_DOWNLOAD_DIR || path.join(os.tmpdir(), "jiang-clips-");

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function sanitizeStem(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "video";
}

function normalizeBrowser(value?: string): string | null {
  if (!value || value === "none") {
    return null;
  }

  const allowed = new Set(["chrome", "firefox", "brave", "edge", "safari", "chromium"]);
  return allowed.has(value) ? value : null;
}

async function runCommand(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(ytDlpBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `yt-dlp exited with code ${code}`));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

async function downloadVideo(
  payload: LocalDownloadRequest,
): Promise<{ filePath: string; fileName: string; title: string }> {
  const workDir = await mkdtemp(localDownloadDir);
  const browser = normalizeBrowser(payload.cookiesBrowser);
  const metadataArgs = ["--dump-single-json", "--no-playlist", "--no-download"];
  if (browser) {
    metadataArgs.push("--cookies-from-browser", browser);
  }
  metadataArgs.push(payload.youtubeUrl);

  const metadataResult = await runCommand(metadataArgs);
  const metadata = JSON.parse(metadataResult.stdout) as { id?: string; title?: string };
  const title = payload.title?.trim() || metadata.title || "video";
  const videoId = metadata.id || Date.now().toString();
  const fileStem = `${sanitizeStem(title)}-${videoId}`;
  const outputTemplate = path.join(workDir, `${fileStem}.%(ext)s`);

  const downloadArgs = [
    "--no-playlist",
    "-f",
    "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
    "--remux-video",
    "mp4",
    "-o",
    outputTemplate,
  ];
  if (browser) {
    downloadArgs.push("--cookies-from-browser", browser);
  }
  downloadArgs.push(payload.youtubeUrl);

  await runCommand(downloadArgs);

  const files = await readdir(workDir);
  const match = files.find((file) => file.startsWith(fileStem));
  if (!match) {
    throw new Error("yt-dlp finished but no downloaded file was found.");
  }

  return {
    filePath: path.join(workDir, match),
    fileName: match,
    title,
  };
}

async function uploadToCloud(
  filePath: string,
  fileName: string,
  payload: LocalDownloadRequest,
  title: string,
): Promise<LocalDownloadResponse> {
  const buffer = await readFile(filePath);
  const fileStats = await stat(filePath);
  const formData = new FormData();
  const uploadFile = new File([buffer], fileName, { type: "video/mp4" });

  formData.set("video", uploadFile);
  formData.set("title", title);
  formData.set("maxClips", payload.maxClips || "5");
  formData.set("generateCaptions", String(Boolean(payload.generateCaptions)));
  formData.set("removeSilence", String(payload.removeSilence ?? true));

  const response = await fetch(`${outputApiUrl}/api/jobs`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(errorPayload?.error || `Cloud upload failed with status ${response.status}`);
  }

  const body = (await response.json()) as LocalDownloadResponse;
  return {
    ...body,
    localFileName: fileName,
    localFilePath: fileStats.isFile() && payload.keepLocalCopy ? filePath : undefined,
  };
}

export async function POST(request: Request): Promise<Response> {
  if (!localDownloadsEnabled) {
    return json(
      {
        error:
          "Local YouTube downloading is disabled. Set LOCAL_YTDLP_ENABLED=true in web/.env.local on your laptop.",
      },
      403,
    );
  }

  const payload = (await request.json()) as LocalDownloadRequest;

  if (!payload.youtubeUrl?.trim()) {
    return json({ error: "youtubeUrl is required." }, 400);
  }

  let filePath = "";
  try {
    const result = await downloadVideo(payload);
    filePath = result.filePath;

    const uploadResult = await uploadToCloud(filePath, result.fileName, payload, result.title);

    if (!payload.keepLocalCopy) {
      await rm(path.dirname(filePath), { recursive: true, force: true });
    }

    return json(uploadResult, 202);
  } catch (err) {
    if (filePath && !payload.keepLocalCopy) {
      await rm(path.dirname(filePath), { recursive: true, force: true }).catch(() => undefined);
    }

    const message = err instanceof Error ? err.message : "Local download bridge failed.";
    return json({ error: message }, 500);
  }
}
