const PERSISTENT_ID_STORAGE_KEY = "wfloat:persistent_id";

function getBrowserStorage(): Storage | null {
  try {
    if (typeof globalThis === "undefined" || !("localStorage" in globalThis)) {
      return null;
    }

    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function getPersistentId(): string | null {
  const storage = getBrowserStorage();
  if (!storage) return null;

  try {
    const value = storage.getItem(PERSISTENT_ID_STORAGE_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function setPersistentId(persistentId: string | null | undefined): void {
  if (!persistentId) return;

  // console.log(persistentId);

  const storage = getBrowserStorage();
  if (!storage) return;

  try {
    storage.setItem(PERSISTENT_ID_STORAGE_KEY, persistentId);
  } catch {
    // Storage writes are best-effort only.
  }
}
