"use strict";
/**
 * Unified Fallback Message Template
 * Used across all services when critical failures occur
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FALLBACK_MESSAGE = void 0;
exports.createFallbackResponse = createFallbackResponse;
exports.isFallbackResponse = isFallbackResponse;
exports.FALLBACK_MESSAGE = "请告诉我的创造者，我的ai出现问题了";
/**
 * Create a standardized fallback response
 */
function createFallbackResponse(reason, error) {
    return {
        success: false,
        text: exports.FALLBACK_MESSAGE,
        audioPath: null,
        error: error?.message,
        fallbackReason: reason,
        timestamp: Date.now(),
    };
}
/**
 * Check if a response is a fallback response
 */
function isFallbackResponse(response) {
    return (response &&
        response.success === false &&
        response.text === exports.FALLBACK_MESSAGE &&
        response.fallbackReason !== undefined);
}
//# sourceMappingURL=FallbackTemplate.js.map