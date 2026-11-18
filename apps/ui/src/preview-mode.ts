/** How the tiles show their streams: a low-resolution live video, or a still picture refreshed now and then. */
export type PreviewMode = "video" | "thumbnails";

/** What the greyed out Live video says while the admin allows thumbnails only. */
export const THUMBNAILS_ONLY_TIP =
  "Your admin has restricted this feature to save resources. Contact them for any questions";

const STORAGE_KEY = "aceswarm.previewMode";

/** The browser's storage; reading it throws where the browser keeps none (some private modes). */
type StorageSource = () => Pick<Storage, "getItem" | "setItem">;

const browserStorage: StorageSource = () => localStorage;

/** The choice this browser keeps under Settings: Live video until it chose otherwise. */
export function loadPreviewChoice(storage: StorageSource = browserStorage): PreviewMode {
  try {
    return storage().getItem(STORAGE_KEY) === "thumbnails" ? "thumbnails" : "video";
  } catch {
    return "video";
  }
}

export function savePreviewChoice(mode: PreviewMode, storage: StorageSource = browserStorage): void {
  try {
    storage().setItem(STORAGE_KEY, mode);
  } catch {
    // Storage can be unavailable (private mode); the setting then lasts for this visit.
  }
}

/**
 * What the tiles show. The admin's thumbnails only (PREVIEW_THUMBNAILS_ONLY, which every snapshot
 * carries) wins over the browser's choice. That choice stays kept: the browser goes back to it
 * once the admin lifts the restriction.
 */
export function effectivePreviewMode(choice: PreviewMode, thumbnailsOnly: boolean): PreviewMode {
  return thumbnailsOnly ? "thumbnails" : choice;
}
