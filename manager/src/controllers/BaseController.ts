import { Response } from 'express';

export abstract class BaseController {
  /**
   * Handle errors consistently across all controllers
   */
  protected handleError(error: unknown, res: Response): void {
    console.error('[Controller] Error:', error);
    
    if (error instanceof Error) {
      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Validate required parameters
   */
  protected validateRequired(params: Record<string, any>, required: string[]): boolean {
    return required.every(key => params[key] !== undefined && params[key] !== null);
  }

  /**
   * Send success response
   */
  protected sendSuccess(res: Response, data: any): void {
    res.json({
      success: true,
      ...data,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Send error response
   */
  protected sendError(res: Response, message: string, statusCode: number = 400): void {
    res.status(statusCode).json({
      success: false,
      error: message,
      timestamp: new Date().toISOString()
    });
  }
}
