"use client";

import type { FormEvent } from "react";
import { startTransition, useDeferredValue, useEffect, useState } from "react";

import { createRun, fetchDashboard, fetchRun, resolveMediaUrl } from "../lib/api";
import type { QueueStats, RunRecord } from "../lib/types";

const defaultQueue: QueueStats = {
  pending: 0,
  running: 0,
  concurrency: 1,
};

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

  return run.status;
}

export default function HomePage() {
  const [queue, setQueue] = useState<QueueStats>(defaultQueue);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunRecord | null>(null);
  const [title, setTitle] = useState("");
  const [maxClips, setMaxClips] = useState("5");
  const [generateCaptions, setGenerateCaptions] = useState(false);
  const [removeSilence, setRemoveSilence] = useState(true);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
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

  return (
    <main className="shell">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">EC2 Control Room</p>
          <h1>Upload once, let the cloud take the heat.</h1>
          <p className="hero-text">
            This dashboard is built for the flow you described: you download YouTube videos on your
            own device, ship the file to EC2, and let the server handle transcription, silence
            cleanup, clip extraction, and final reel rendering.
          </p>
        </div>

        <div className="queue-card">
          <span className="queue-label">Queue</span>
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
        <form className="panel upload-panel" onSubmit={handleSubmit}>
          <div className="panel-head">
            <div>
              <p className="eyebrow">New Run</p>
              <h2>Send an uploaded source video</h2>
            </div>
            <span className="pill">{generateCaptions ? "Caption Mode" : "Fast Mode"}</span>
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

          <button className="primary-button" disabled={isUploading} type="submit">
            {isUploading ? "Queueing..." : "Start Cloud Run"}
          </button>

          <p className="supporting-copy">
            Default profile is tuned for a 4 GB EC2 instance: one worker, smaller Whisper model,
            captions off by default, and only a handful of clips per job.
          </p>

          {message ? <p className="message">{message}</p> : null}
        </form>

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
            {selectedRun ? <span className="pill">{selectedRun.status}</span> : null}
          </div>

          {selectedRun ? (
            <div className="detail-grid">
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
