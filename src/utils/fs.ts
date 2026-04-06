import { mkdirSync, readdirSync, rmSync, existsSync } from "fs";
import { basename, extname, join } from "path";

export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

export function runDir(basePath: string, runId: string): string {
  const dir = join(basePath, "runs", runId);
  for (const sub of ["downloads", "clips", "desilenced", "captions", "transcripts"]) {
    ensureDir(join(dir, sub));
  }
  return dir;
}

export async function fileExists(filePath: string): Promise<boolean> {
  return Bun.file(filePath).exists();
}

export function cleanRunArtifacts(basePath: string, runId: string, keepFinal: boolean): void {
  const dir = join(basePath, "runs", runId);
  if (!existsSync(dir)) return;
  if (keepFinal) {
    for (const sub of ["clips", "desilenced", "captions", "downloads"]) {
      const subDir = join(dir, sub);
      if (existsSync(subDir)) rmSync(subDir, { recursive: true, force: true });
    }
  } else {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function listFiles(dirPath: string, extension?: string): string[] {
  if (!existsSync(dirPath)) return [];
  const files = readdirSync(dirPath);
  if (extension) return files.filter((f) => f.endsWith(extension)).map((f) => join(dirPath, f));
  return files.map((f) => join(dirPath, f));
}

export function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function sanitizeFileName(fileName: string): string {
  const ext = extname(fileName);
  const base = basename(fileName, ext)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const safeBase = base || "video";
  const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, "") || ".mp4";
  return `${safeBase}${safeExt}`;
}

export function slugify(value: string, fallback = "video"): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}
