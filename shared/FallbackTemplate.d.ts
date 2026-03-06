/**
 * Unified Fallback Message Template
 * Used across all services when critical failures occur
 */
export declare const FALLBACK_MESSAGE = "\u8BF7\u544A\u8BC9\u6211\u7684\u521B\u9020\u8005\uFF0C\u6211\u7684ai\u51FA\u73B0\u95EE\u9898\u4E86";
/**
 * Response structure for fallback scenarios
 */
export interface FallbackResponse {
    success: false;
    text: string;
    audioPath?: null;
    error?: string;
    fallbackReason: string;
    timestamp: number;
}
/**
 * Create a standardized fallback response
 */
export declare function createFallbackResponse(reason: string, error?: Error): FallbackResponse;
/**
 * Check if a response is a fallback response
 */
export declare function isFallbackResponse(response: any): response is FallbackResponse;
