export type Live2dLocalVisibilityMode = 'visible' | 'obs_hidden';

export interface MemorySuiteLive2dShellState {
  available: boolean;
  visible: boolean;
  clickThrough: boolean;
  alwaysOnTop: boolean;
  localVisibilityMode: Live2dLocalVisibilityMode;
}

export type MemorySuiteScreenCaptureSourceType = 'screen' | 'window';

export interface MemorySuiteWindowApi {
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  onMaximizeChange: (callback: (maximized: boolean) => void) => (() => void) | undefined;
}

export interface MemorySuiteLive2dWindowApi {
  getBounds: () => Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
    workArea: { x: number; y: number; width: number; height: number };
  } | null>;
  setPosition: (x: number, y: number) => void;
  getShellState: () => Promise<MemorySuiteLive2dShellState>;
  setLocalVisibilityMode: (
    mode: Live2dLocalVisibilityMode,
  ) => Promise<MemorySuiteLive2dShellState>;
}

export interface MemorySuiteScreenCaptureApi {
  setPreferredSourceTypes: (
    types: MemorySuiteScreenCaptureSourceType[],
  ) => Promise<MemorySuiteScreenCaptureSourceType[]>;
}

declare global {
  interface Window {
    memorySuiteWindow?: MemorySuiteWindowApi;
    memorySuiteLive2dWindow?: MemorySuiteLive2dWindowApi;
    memorySuiteScreenCapture?: MemorySuiteScreenCaptureApi;
  }
}
