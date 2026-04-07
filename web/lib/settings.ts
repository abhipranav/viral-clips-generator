export type CookiesBrowser =
  | "chrome"
  | "brave"
  | "firefox"
  | "edge"
  | "safari"
  | "chromium"
  | "none";

export interface AppSettings {
  defaultMaxClips: number;
  defaultGenerateCaptions: boolean;
  defaultRemoveSilence: boolean;
  pollIntervalSeconds: number;
  autoRefreshDashboard: boolean;
  autoSelectNewestRun: boolean;
  localBridgeCookiesBrowser: CookiesBrowser;
  localBridgeKeepLocalCopy: boolean;
  showIncompleteWarning: boolean;
  compactRunCards: boolean;
  enableRunCompletionNotification: boolean;
  previewMutedByDefault: boolean;
  previewAutoplay: boolean;
  maxVisiblePreviewCards: number;
  confirmBeforeQueue: boolean;
}

export const appSettingsDefaults: AppSettings = {
  defaultMaxClips: 5,
  defaultGenerateCaptions: false,
  defaultRemoveSilence: true,
  pollIntervalSeconds: 5,
  autoRefreshDashboard: true,
  autoSelectNewestRun: true,
  localBridgeCookiesBrowser: "chrome",
  localBridgeKeepLocalCopy: false,
  showIncompleteWarning: true,
  compactRunCards: false,
  enableRunCompletionNotification: false,
  previewMutedByDefault: true,
  previewAutoplay: false,
  maxVisiblePreviewCards: 6,
  confirmBeforeQueue: false,
};

const appSettingsStorageKey = "jiang-clips-app-settings";

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.floor(value)));
}

function asCookiesBrowser(value: unknown, fallback: CookiesBrowser): CookiesBrowser {
  const candidates: CookiesBrowser[] = [
    "chrome",
    "brave",
    "firefox",
    "edge",
    "safari",
    "chromium",
    "none",
  ];

  if (typeof value === "string" && candidates.includes(value as CookiesBrowser)) {
    return value as CookiesBrowser;
  }

  return fallback;
}

export function normalizeSettings(payload: Partial<AppSettings> | null | undefined): AppSettings {
  const source = payload ?? {};

  return {
    defaultMaxClips: asNumber(source.defaultMaxClips, appSettingsDefaults.defaultMaxClips, 1, 20),
    defaultGenerateCaptions: asBoolean(
      source.defaultGenerateCaptions,
      appSettingsDefaults.defaultGenerateCaptions,
    ),
    defaultRemoveSilence: asBoolean(source.defaultRemoveSilence, appSettingsDefaults.defaultRemoveSilence),
    pollIntervalSeconds: asNumber(
      source.pollIntervalSeconds,
      appSettingsDefaults.pollIntervalSeconds,
      2,
      60,
    ),
    autoRefreshDashboard: asBoolean(source.autoRefreshDashboard, appSettingsDefaults.autoRefreshDashboard),
    autoSelectNewestRun: asBoolean(source.autoSelectNewestRun, appSettingsDefaults.autoSelectNewestRun),
    localBridgeCookiesBrowser: asCookiesBrowser(
      source.localBridgeCookiesBrowser,
      appSettingsDefaults.localBridgeCookiesBrowser,
    ),
    localBridgeKeepLocalCopy: asBoolean(
      source.localBridgeKeepLocalCopy,
      appSettingsDefaults.localBridgeKeepLocalCopy,
    ),
    showIncompleteWarning: asBoolean(
      source.showIncompleteWarning,
      appSettingsDefaults.showIncompleteWarning,
    ),
    compactRunCards: asBoolean(source.compactRunCards, appSettingsDefaults.compactRunCards),
    enableRunCompletionNotification: asBoolean(
      source.enableRunCompletionNotification,
      appSettingsDefaults.enableRunCompletionNotification,
    ),
    previewMutedByDefault: asBoolean(source.previewMutedByDefault, appSettingsDefaults.previewMutedByDefault),
    previewAutoplay: asBoolean(source.previewAutoplay, appSettingsDefaults.previewAutoplay),
    maxVisiblePreviewCards: asNumber(
      source.maxVisiblePreviewCards,
      appSettingsDefaults.maxVisiblePreviewCards,
      1,
      20,
    ),
    confirmBeforeQueue: asBoolean(source.confirmBeforeQueue, appSettingsDefaults.confirmBeforeQueue),
  };
}

export function loadAppSettings(): AppSettings {
  if (typeof window === "undefined") {
    return appSettingsDefaults;
  }

  try {
    const raw = window.localStorage.getItem(appSettingsStorageKey);
    if (!raw) {
      return appSettingsDefaults;
    }

    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return normalizeSettings(parsed);
  } catch {
    return appSettingsDefaults;
  }
}

export function saveAppSettings(settings: AppSettings): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(appSettingsStorageKey, JSON.stringify(normalizeSettings(settings)));
}

export function serializeSettings(settings: AppSettings): string {
  return JSON.stringify(normalizeSettings(settings), null, 2);
}

export function parseSettings(raw: string): AppSettings {
  const parsed = JSON.parse(raw) as Partial<AppSettings>;
  return normalizeSettings(parsed);
}
