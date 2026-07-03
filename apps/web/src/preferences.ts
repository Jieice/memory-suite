export type ThemeMode = '日间' | '夜间' | '跟随系统';

export interface UiPreferences {
  developerMode: boolean;
  themeMode: ThemeMode;
  compactNavigation: boolean;
}

const STORAGE_KEY = 'memory-suite:ui-preferences';
const CHANGE_EVENT = 'memory-suite:ui-preferences-change';

export const defaultUiPreferences: UiPreferences = {
  developerMode: false,
  themeMode: '日间',
  compactNavigation: true,
};

export function loadUiPreferences(): UiPreferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultUiPreferences;
    const parsed = JSON.parse(raw) as Partial<UiPreferences>;
    return {
      ...defaultUiPreferences,
      ...parsed,
    };
  } catch {
    return defaultUiPreferences;
  }
}

export function saveUiPreferences(preferences: UiPreferences): UiPreferences {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: preferences }));
  return preferences;
}

export function updateUiPreferences(patch: Partial<UiPreferences>): UiPreferences {
  return saveUiPreferences({
    ...loadUiPreferences(),
    ...patch,
  });
}

export function subscribeUiPreferences(listener: (preferences: UiPreferences) => void) {
  const handleCustomEvent = (event: Event) => {
    listener((event as CustomEvent<UiPreferences>).detail ?? loadUiPreferences());
  };
  const handleStorageEvent = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener(loadUiPreferences());
  };

  window.addEventListener(CHANGE_EVENT, handleCustomEvent);
  window.addEventListener('storage', handleStorageEvent);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handleCustomEvent);
    window.removeEventListener('storage', handleStorageEvent);
  };
}
