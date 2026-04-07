"use client";

import Link from "next/link";
import { type ChangeEvent, useMemo, useState } from "react";

import {
  appSettingsDefaults,
  loadAppSettings,
  parseSettings,
  saveAppSettings,
  serializeSettings,
  type AppSettings,
  type CookiesBrowser,
} from "../../lib/settings";

function applyPreset(preset: "ec2-safe" | "balanced" | "throughput"): AppSettings {
  if (preset === "ec2-safe") {
    return {
      ...appSettingsDefaults,
      defaultMaxClips: 3,
      defaultGenerateCaptions: false,
      defaultRemoveSilence: true,
      pollIntervalSeconds: 8,
      autoRefreshDashboard: true,
      previewAutoplay: false,
      maxVisiblePreviewCards: 4,
      confirmBeforeQueue: true,
    };
  }

  if (preset === "throughput") {
    return {
      ...appSettingsDefaults,
      defaultMaxClips: 10,
      defaultGenerateCaptions: true,
      defaultRemoveSilence: true,
      pollIntervalSeconds: 3,
      autoRefreshDashboard: true,
      previewAutoplay: true,
      maxVisiblePreviewCards: 10,
      confirmBeforeQueue: false,
    };
  }

  return {
    ...appSettingsDefaults,
    defaultMaxClips: 6,
    defaultGenerateCaptions: true,
    defaultRemoveSilence: true,
    pollIntervalSeconds: 5,
    autoRefreshDashboard: true,
    previewAutoplay: false,
    maxVisiblePreviewCards: 8,
    confirmBeforeQueue: false,
  };
}

export default function SettingsPage() {
  const [draft, setDraft] = useState<AppSettings>(() => loadAppSettings());
  const [savedSnapshot, setSavedSnapshot] = useState<string>(() => serializeSettings(loadAppSettings()));
  const [message, setMessage] = useState<string>("");

  const draftSnapshot = useMemo(() => serializeSettings(draft), [draft]);
  const hasUnsavedChanges = draftSnapshot !== savedSnapshot;

  function updateNumber<K extends keyof AppSettings>(key: K, value: string): void {
    const numeric = Number.parseInt(value, 10);
    if (Number.isNaN(numeric)) {
      return;
    }

    setDraft((current) => ({
      ...current,
      [key]: numeric,
    }));
  }

  function updateBoolean<K extends keyof AppSettings>(key: K, checked: boolean): void {
    setDraft((current) => ({
      ...current,
      [key]: checked,
    }));
  }

  function updateBrowser(value: string): void {
    setDraft((current) => ({
      ...current,
      localBridgeCookiesBrowser: value as CookiesBrowser,
    }));
  }

  function save(): void {
    saveAppSettings(draft);
    const nextSnapshot = serializeSettings(draft);
    setSavedSnapshot(nextSnapshot);
    setMessage("Settings saved locally in your browser.");
  }

  function resetToDefaults(): void {
    setDraft(appSettingsDefaults);
    setMessage("Defaults loaded. Click Save to persist them.");
  }

  function exportSettings(): void {
    const blob = new Blob([serializeSettings(draft)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "jiang-clips-settings.json";
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage("Settings exported as JSON.");
  }

  async function importSettings(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const parsed = parseSettings(text);
      setDraft(parsed);
      setMessage("Imported settings loaded. Click Save to persist them.");
    } catch {
      setMessage("Could not import that file. Make sure it is valid JSON.");
    }
  }

  return (
    <main className="settings-shell">
      <section className="settings-hero">
        <div>
          <p className="eyebrow">Control Surface</p>
          <h1>Settings That Actually Matter</h1>
          <p className="hero-text">
            Tune processing defaults, dashboard behavior, alerts, and guardrails. These preferences
            are saved in your browser so your workflow feels consistent every day.
          </p>
        </div>
        <div className="settings-hero-actions">
          <Link className="secondary-button" href="/">
            Back to Dashboard
          </Link>
          <button className="primary-button" onClick={save} type="button">
            Save Settings
          </button>
        </div>
      </section>

      <section className="settings-grid">
        <article className="panel settings-card settings-card-wide">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Presets</p>
              <h2>Quick profile switch</h2>
            </div>
            <span className={`pill ${hasUnsavedChanges ? "pill-warning" : ""}`}>
              {hasUnsavedChanges ? "Unsaved Changes" : "All Saved"}
            </span>
          </div>
          <div className="preset-grid">
            <button className="secondary-button" onClick={() => setDraft(applyPreset("ec2-safe"))} type="button">
              EC2 Safe
            </button>
            <button className="secondary-button" onClick={() => setDraft(applyPreset("balanced"))} type="button">
              Balanced
            </button>
            <button className="secondary-button" onClick={() => setDraft(applyPreset("throughput"))} type="button">
              Throughput
            </button>
          </div>
          <p className="supporting-copy">
            Use presets as a starting point, then fine-tune below. Save once when you are happy.
          </p>
        </article>

        <article className="panel settings-card">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Processing Defaults</p>
              <h2>Queue behavior</h2>
            </div>
          </div>

          <label className="field">
            <span>Default max clips</span>
            <input
              max="20"
              min="1"
              onChange={(event) => updateNumber("defaultMaxClips", event.target.value)}
              type="number"
              value={draft.defaultMaxClips}
            />
          </label>

          <label className="toggle">
            <input
              checked={draft.defaultGenerateCaptions}
              onChange={(event) => updateBoolean("defaultGenerateCaptions", event.target.checked)}
              type="checkbox"
            />
            <span>Generate captions by default</span>
          </label>

          <label className="toggle">
            <input
              checked={draft.defaultRemoveSilence}
              onChange={(event) => updateBoolean("defaultRemoveSilence", event.target.checked)}
              type="checkbox"
            />
            <span>Remove silence by default</span>
          </label>

          <label className="toggle">
            <input
              checked={draft.confirmBeforeQueue}
              onChange={(event) => updateBoolean("confirmBeforeQueue", event.target.checked)}
              type="checkbox"
            />
            <span>Require confirmation before starting a run</span>
          </label>
        </article>

        <article className="panel settings-card">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Dashboard</p>
              <h2>Monitoring UX</h2>
            </div>
          </div>

          <label className="field">
            <span>Refresh interval (seconds)</span>
            <input
              max="60"
              min="2"
              onChange={(event) => updateNumber("pollIntervalSeconds", event.target.value)}
              type="number"
              value={draft.pollIntervalSeconds}
            />
          </label>

          <label className="toggle">
            <input
              checked={draft.autoRefreshDashboard}
              onChange={(event) => updateBoolean("autoRefreshDashboard", event.target.checked)}
              type="checkbox"
            />
            <span>Auto refresh queue and run status</span>
          </label>

          <label className="toggle">
            <input
              checked={draft.autoSelectNewestRun}
              onChange={(event) => updateBoolean("autoSelectNewestRun", event.target.checked)}
              type="checkbox"
            />
            <span>Auto select newest run</span>
          </label>

          <label className="toggle">
            <input
              checked={draft.compactRunCards}
              onChange={(event) => updateBoolean("compactRunCards", event.target.checked)}
              type="checkbox"
            />
            <span>Use compact run cards</span>
          </label>

          <label className="toggle">
            <input
              checked={draft.showIncompleteWarning}
              onChange={(event) => updateBoolean("showIncompleteWarning", event.target.checked)}
              type="checkbox"
            />
            <span>Highlight incomplete runs with warning cards</span>
          </label>
        </article>

        <article className="panel settings-card">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Local Bridge</p>
              <h2>Download preferences</h2>
            </div>
          </div>

          <label className="field">
            <span>Default browser cookies source</span>
            <select
              className="select-input"
              onChange={(event) => updateBrowser(event.target.value)}
              value={draft.localBridgeCookiesBrowser}
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
              checked={draft.localBridgeKeepLocalCopy}
              onChange={(event) => updateBoolean("localBridgeKeepLocalCopy", event.target.checked)}
              type="checkbox"
            />
            <span>Keep local file copy by default</span>
          </label>
        </article>

        <article className="panel settings-card">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Previews & Alerts</p>
              <h2>Feedback loop speed</h2>
            </div>
          </div>

          <label className="field">
            <span>Max visible preview cards</span>
            <input
              max="20"
              min="1"
              onChange={(event) => updateNumber("maxVisiblePreviewCards", event.target.value)}
              type="number"
              value={draft.maxVisiblePreviewCards}
            />
          </label>

          <label className="toggle">
            <input
              checked={draft.previewMutedByDefault}
              onChange={(event) => updateBoolean("previewMutedByDefault", event.target.checked)}
              type="checkbox"
            />
            <span>Mute previews by default</span>
          </label>

          <label className="toggle">
            <input
              checked={draft.previewAutoplay}
              onChange={(event) => updateBoolean("previewAutoplay", event.target.checked)}
              type="checkbox"
            />
            <span>Autoplay preview videos when loaded</span>
          </label>

          <label className="toggle">
            <input
              checked={draft.enableRunCompletionNotification}
              onChange={(event) => updateBoolean("enableRunCompletionNotification", event.target.checked)}
              type="checkbox"
            />
            <span>Desktop notification when a run completes</span>
          </label>
        </article>

        <article className="panel settings-card settings-card-wide">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Data Controls</p>
              <h2>Import, export, and reset</h2>
            </div>
          </div>

          <div className="settings-actions-grid">
            <button className="secondary-button" onClick={exportSettings} type="button">
              Export JSON
            </button>
            <label className="secondary-button secondary-file-input">
              Import JSON
              <input accept="application/json" onChange={importSettings} type="file" />
            </label>
            <button className="secondary-button danger-button" onClick={resetToDefaults} type="button">
              Reset to defaults
            </button>
          </div>

          <p className="supporting-copy">
            Message: {message || "No recent action."}
          </p>
        </article>

        <article className="panel settings-card settings-card-wide">
          <div className="panel-head">
            <div>
              <p className="eyebrow">What Else To Add</p>
              <h2>High-impact product upgrades</h2>
            </div>
          </div>
          <div className="ideas-grid">
            <div className="idea-card">
              <h3>Template Packs</h3>
              <p>Reusable style profiles for captions, pacing, and clip lengths by platform.</p>
            </div>
            <div className="idea-card">
              <h3>A/B Hook Testing</h3>
              <p>Generate multiple intros per clip and rank them by engagement predictions.</p>
            </div>
            <div className="idea-card">
              <h3>Publishing Queue</h3>
              <p>Schedule direct exports to Shorts, Reels, and TikTok with per-platform metadata.</p>
            </div>
            <div className="idea-card">
              <h3>Quality Scorecards</h3>
              <p>Auto-grade every run for caption readability, pacing, and dead-air percent.</p>
            </div>
            <div className="idea-card">
              <h3>Team Workspaces</h3>
              <p>Shared projects with role-based controls for editors, reviewers, and publishers.</p>
            </div>
            <div className="idea-card">
              <h3>Auto Recovery</h3>
              <p>Detect incomplete runs and offer one-click resume directly in the dashboard.</p>
            </div>
          </div>
        </article>
      </section>
    </main>
  );
}
