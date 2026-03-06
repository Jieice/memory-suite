/**
 * ToolOrchestrator - 工具编排器
 * 简化版：暂时不调用实际工具，返回空结果
 */

class ToolOrchestrator {
  constructor() {
    console.log('[ToolOrchestrator] 初始化（简化版）');
  }

  /**
   * 编排工具调用
   * @param {string} userText 用户输入
   * @param {string} userId 用户ID
   * @param {any} context 上下文
   */
  async orchestrate(userText, userId, context) {
    console.log(`[ToolOrchestrator] ????: "${userText}" from ${userId}`);

    return {
      success: true,
      response: null
    };
  }
}

module.exports = { ToolOrchestrator };
