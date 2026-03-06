/**
 * Unified fallback message shown to users when core generation fails.
 */

export const FALLBACK_MESSAGE = "抱歉，我刚刚有点卡住了。你再说一遍，我马上继续。";

/**
 * Response structure for fallback scenarios
 */
export interface FallbackResponse {
  success: false;
  text: string;
  audioPath?: null;
  error?: string;  // Internal logging only, not sent to user
  fallbackReason: string;  // For logging and debugging
  timestamp: number;
}

/**
 * Create a standardized fallback response
 */
export function createFallbackResponse(
  reason: string,
  error?: Error
): FallbackResponse {
  return {
    success: false,
    text: FALLBACK_MESSAGE,
    audioPath: null,
    error: error?.message,
    fallbackReason: reason,
    timestamp: Date.now(),
  };
}

/**
 * Check if a response is a fallback response
 */
export function isFallbackResponse(response: any): response is FallbackResponse {
  return (
    response &&
    response.success === false &&
    response.text === FALLBACK_MESSAGE &&
    response.fallbackReason !== undefined
  );
}
