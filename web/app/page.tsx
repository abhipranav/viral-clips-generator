"use client";

import type { FormEvent } from "react";
import { startTransition, useDeferredValue, useEffect, useState } from "react";

import {
  createRun,
  createRunFromYouTube,
  fetchDashboard,
  fetchRun,
  resolveMediaUrl,
} from "../lib/api";
import type { QueueStats, RunRecord } from "../lib/types";

const defaultQueue: QueueStats = {
  pending: 0,
  running: 0,
  concurrency: 1,
};
const localDownloaderEnabled = process.env.NEXT_PUBLIC_LOCAL_YTDLP_ENABLED === "true";
const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:3001";

function getWorkerMode(baseUrl: string): {
  label: string;
  shortLabel: string;
  description: string;
} {
  const normalized = baseUrl.toLowerCase();
  const isLocal =
    normalized.includes("127.0.0.1") ||
    normalized.includes("localhost") ||
    normalized.includes("0.0.0.0");

  if (isLocal) {
    return {
      label: "Local Worker",
      shortLabel: "Local",
      description:
        "This dashboard is currently targeting a worker on this machine. Uploads and processing stay local unless you point the API at EC2.",
    };
  }

  return {
    label: "Remote Worker",
    shortLabel: "Remote",
    description:
      "This dashboard is currently targeting a remote worker, such as your EC2 box. Your laptop can still do local yt-dlp downloads and forward the finished file upstream.",
  };
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function statusLabel(run: RunRecord): string {
  if (run.status === "running") {
    return `${run.status} · ${run.currentStage}`;
  }

  if (run.status === "incomplete") {
    return `incomplete · stalled at ${run.currentStage}`;
  }

  return run.status;
}

export default function HomePage() {
  const workerMode = getWorkerMode(apiBaseUrl);
  const [queue, setQueue] = useState<QueueStats>(defaultQueue);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunRecord | null>(null);
  const [title, setTitle] = useState("");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [cookiesBrowser, setCookiesBrowser] = useState("chrome");
  const [keepLocalCopy, setKeepLocalCopy] = useState(false);
  const [maxClips, setMaxClips] = useState("5");
  const [generateCaptions, setGenerateCaptions] = useState(false);
  const [removeSilence, setRemoveSilence] = useState(true);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isLocalDownloading, setIsLocalDownloading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [localMessage, setLocalMessage] = useState<string | null>(null);
  const deferredRuns = useDeferredValue(runs);

  useEffect(() => {
    let disposed = false;

    const loadDashboard = async (): Promise<void> => {
      const data = await fetchDashboard();
      if (disposed) {
        return;
      }

      setQueue(data.queue);
      setRuns(data.runs);

      if (!selectedRunId && data.runs.length > 0) {
        startTransition(() => {
          setSelectedRunId(data.runs[0].id);
        });
        return;
      }

      if (selectedRunId) {
        const match = data.runs.find((run) => run.id === selectedRunId);
        if (match) {
          setSelectedRun(match);
        }
      }
    };

    void loadDashboard();

    const intervalId = window.setInterval(() => {
      void loadDashboard();
    }, 5000);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [selectedRunId]);

  useEffect(() => {
    if (!selectedRunId) {
      setSelectedRun(null);
      return;
    }

    let disposed = false;

    const loadDetail = async (): Promise<void> => {
      const detail = await fetchRun(selectedRunId);
      if (disposed) {
        return;
      }

      setQueue(detail.queue);
      setSelectedRun(detail.run);
    };

    void loadDetail();

    return () => {
      disposed = true;
    };
  }, [selectedRunId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (!videoFile) {
      setMessage("Choose a video file before starting a run.");
      return;
    }

    setIsUploading(true);
    setMessage(null);

    try {
      const formData = new FormData();
      formData.set("video", videoFile);
      formData.set("title", title);
      formData.set("maxClips", maxClips);
      formData.set("generateCaptions", String(generateCaptions));
      formData.set("removeSilence", String(removeSilence));

      const response = await createRun(formData);
      setMessage(`Run queued: ${response.runId}`);
      setVideoFile(null);
      setTitle("");

      startTransition(() => {
        setSelectedRunId(response.runId);
      });

      const dashboard = await fetchDashboard();
      setQueue(dashboard.queue);
      setRuns(dashboard.runs);

      const detail = await fetchRun(response.runId);
      setQueue(detail.queue);
      setSelectedRun(detail.run);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to queue the run.");
    } finally {
      setIsUploading(false);
    }
  }

  async function handleLocalDownload(): Promise<void> {
    if (!youtubeUrl.trim()) {
      setLocalMessage("Paste a YouTube URL before starting the local bridge.");
      return;
    }

    setIsLocalDownloading(true);
    setLocalMessage(null);

    try {
      const response = await createRunFromYouTube({
        youtubeUrl,
        title,
        maxClips,
        generateCaptions,
        removeSilence,
        cookiesBrowser,
        keepLocalCopy,
      });

      setLocalMessage(
        response.localFilePath
          ? `Downloaded locally and queued as ${response.runId}. Kept copy at ${response.localFilePath}`
          : `Downloaded locally and queued as ${response.runId}.`,
      );
      setYoutubeUrl("");

      startTransition(() => {
        setSelectedRunId(response.runId);
      });

      const dashboard = await fetchDashboard();
      setQueue(dashboard.queue);
      setRuns(dashboard.runs);

      const detail = await fetchRun(response.runId);
      setQueue(detail.queue);
      setSelectedRun(detail.run);
    } catch (err) {
      setLocalMessage(err instanceof Error ? err.message : "Local download bridge failed.");
    } finally {
      setIsLocalDownloading(false);
    }
  }

  return (
    <main className="shell">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">{workerMode.label}</p>
          <h1>
            {workerMode.shortLabel === "Local"
              ? "Run the worker here, or point it somewhere bigger."
              : "Use your laptop as the bridge and let the remote worker take the heat."}
          </h1>
          <p className="hero-text">
            {workerMode.description}
          </p>
          <p className="supporting-copy">Active API target: {apiBaseUrl}</p>
        </div>

        <div className="queue-card">
          <span className="queue-label">{workerMode.shortLabel} Queue</span>
          <strong>{queue.running}</strong>
          <p>running now</p>
          <div className="queue-grid">
            <div>
              <span>Pending</span>
              <strong>{queue.pending}</strong>
            </div>
            <div>
              <span>Workers</span>
              <strong>{queue.concurrency}</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="workspace">
        <section className="panel upload-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">New Run</p>
              <h2>
                Pick your input source for the {workerMode.shortLabel.toLowerCase()} worker
              </h2>
            </div>
            <span className="pill">{generateCaptions ? "Caption Mode" : "Fast Mode"}</span>
          </div>

          <label className="field">
            <span>Clip pack title</span>
            <input
              type="text"
              placeholder="Optional project title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>

          <div className="field-row">
            <label className="field">
              <span>Max clips</span>
              <input
                type="number"
                min="1"
                max="20"
                value={maxClips}
                onChange={(event) => setMaxClips(event.target.value)}
              />
            </label>

            <label className="toggle">
              <input
                type="checkbox"
                checked={removeSilence}
                onChange={(event) => setRemoveSilence(event.target.checked)}
              />
              <span>Remove dead air</span>
            </label>

            <label className="toggle">
              <input
                type="checkbox"
                checked={generateCaptions}
                onChange={(event) => setGenerateCaptions(event.target.checked)}
              />
              <span>Render captions</span>
            </label>
          </div>

          <div className="source-section">
            <div className="section-header">
              <div>
                <p className="eyebrow">Laptop Bridge</p>
                <h3>
                  Download with local yt-dlp, then forward to the{" "}
                  {workerMode.shortLabel.toLowerCase()} worker
                </h3>
              </div>
              <span className={`pill ${localDownloaderEnabled ? "" : "pill-muted"}`}>
                {localDownloaderEnabled ? "Enabled Here" : "Disabled Here"}
              </span>
            </div>

            <label className="field">
              <span>YouTube URL</span>
              <input
                type="url"
                placeholder="https://www.youtube.com/watch?v=..."
                value={youtubeUrl}
                onChange={(event) => setYoutubeUrl(event.target.value)}
              />
            </label>

            <label className="field">
              <span>Cookies source</span>
              <select
                className="select-input"
                value={cookiesBrowser}
                onChange={(event) => setCookiesBrowser(event.target.value)}
              >
                <option value="chrome">Chrome</option>
                <option value="brave">Brave</option>
                <option value="firefox">Firefox</option>
                <option value="edge">Edge</option>
                <option value="safari">Safari</option>
                <option value="chromium">Chromium</option>
                <option value="none">No browser cookies</option>
              </select>
            </label>

            <label className="toggle">
              <input
                type="checkbox"
                checked={keepLocalCopy}
                onChange={(event) => setKeepLocalCopy(event.target.checked)}
              />
              <span>Keep local copy after upload</span>
            </label>

            <button
              className="primary-button"
              disabled={!localDownloaderEnabled || isLocalDownloading}
              onClick={() => {
                void handleLocalDownload();
              }}
              type="button"
            >
              {isLocalDownloading ? "Downloading Locally..." : "Download Here, Run On EC2"}
            </button>

            <p className="supporting-copy">
              Run the Next app on your Mac with `LOCAL_YTDLP_ENABLED=true` and `yt-dlp`
              installed. This route downloads on your laptop, then uploads to {apiBaseUrl}.
            </p>

            {localMessage ? <p className="message">{localMessage}</p> : null}
          </div>

          <div className="panel-divider" />

          <form className="source-section" onSubmit={handleSubmit}>
            <div className="section-header">
              <div>
                <p className="eyebrow">Manual Upload</p>
                <h3>
                  Pick a finished video file and send it to the{" "}
                  {workerMode.shortLabel.toLowerCase()} worker
                </h3>
              </div>
            </div>

            <label className="field">
              <span>Video file</span>
              <input
                type="file"
                accept="video/*"
                onChange={(event) => {
                  const nextFile = event.target.files?.[0] || null;
                  setVideoFile(nextFile);
                }}
              />
            </label>

            <button className="primary-button" disabled={isUploading} type="submit">
              {isUploading ? "Queueing..." : "Upload File To EC2"}
            </button>
          </form>

          <p className="supporting-copy">
            Default profile is tuned conservatively for a 4 GB box: one worker, smaller Whisper
            model, captions off by default, and only a handful of clips per job.
          </p>

          {message ? <p className="message">{message}</p> : null}
        </section>

        <section className="panel run-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Runs</p>
              <h2>Recent jobs</h2>
            </div>
            <span className="pill">{deferredRuns.length} tracked</span>
          </div>

          <div className="run-list">
            {deferredRuns.map((run) => (
              <button
                key={run.id}
                className={`run-card ${selectedRunId === run.id ? "active" : ""}`}
                onClick={() => {
                  startTransition(() => {
                    setSelectedRunId(run.id);
                  });
                }}
                type="button"
              >
                <div>
                  <strong>{run.videoTitle || run.videoId}</strong>
                  <p>{statusLabel(run)}</p>
                </div>
                <span>{formatTimestamp(run.updatedAt)}</span>
              </button>
            ))}

            {deferredRuns.length === 0 ? (
              <div className="empty-state">
                <strong>No runs yet</strong>
                <p>Your first upload will appear here.</p>
              </div>
            ) : null}
          </div>
        </section>

        <section className="panel detail-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Details</p>
              <h2>{selectedRun?.videoTitle || "Choose a run"}</h2>
            </div>
            {selectedRun ? (
              <span className={`pill ${selectedRun.status === "incomplete" ? "pill-warning" : ""}`}>
                {selectedRun.status}
              </span>
            ) : null}
          </div>

          {selectedRun ? (
            <div className="detail-grid">
              {selectedRun.status === "incomplete" ? (
                <article className="detail-block detail-warning">
                  <h3>Needs Resume</h3>
                  <p className="supporting-copy">
                    This run was previously stored as completed, but its clip stages never reached
                    final output. Resume it from the backend to finish captions and reel
                    composition.
                  </p>
                  <code className="inline-command">bun run resume {selectedRun.id}</code>
                </article>
              ) : null}

              <article className="detail-block">
                <h3>Pipeline</h3>
                <div className="stage-list">
                  {selectedRun.stages.map((stage) => (
                    <div key={stage.stage} className="stage-row">
                      <strong>{stage.stage}</strong>
                      <span>{stage.status}</span>
                    </div>
                  ))}
                </div>
              </article>

              <article className="detail-block">
                <h3>Generated Clips</h3>
                <div className="clip-list">
                  {selectedRun.outputs.length > 0 ? (
                    selectedRun.outputs.map((output) => (
                      <div key={output.clipId} className="clip-card">
                        <div>
                          <strong>{output.title}</strong>
                          <p>{output.clipId}</p>
                        </div>
                        {output.url ? (
                          <video controls preload="metadata" src={resolveMediaUrl(output.url)} />
                        ) : null}
                      </div>
                    ))
                  ) : (
                    <p className="supporting-copy">
                      Final rendered reels will appear here as soon as the compose stage finishes.
                    </p>
                  )}
                </div>
              </article>

              <article className="detail-block">
                <h3>Clip Progress</h3>
                <div className="stage-list">
                  {selectedRun.clips.map((clip) => (
                    <div key={`${clip.clipId}-${clip.stage}`} className="stage-row">
                      <strong>{clip.title}</strong>
                      <span>{clip.status}</span>
                    </div>
                  ))}
                </div>
              </article>
            </div>
          ) : (
            <div className="empty-state">
              <strong>No run selected</strong>
              <p>Pick a job from the list to inspect stages and final clips.</p>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
