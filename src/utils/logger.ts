/**
 * Centralized logging utility for consistent error, warning, and info logging
 */
export class Logger {
  /**
   * Log error with stack trace and context
   */
  static error(message: string, error: any, context?: any): void {
    console.error(`[ERROR] ${message}`, {
      error: error?.message || error,
      stack: error?.stack,
      context,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Log informational message
   */
  static info(message: string, data?: any): void {
    console.log(`[INFO] ${message}`, data ? { data, timestamp: new Date().toISOString() } : { timestamp: new Date().toISOString() });
  }

  /**
   * Log warning message
   */
  static warn(message: string, data?: any): void {
    console.warn(`[WARN] ${message}`, data ? { data, timestamp: new Date().toISOString() } : { timestamp: new Date().toISOString() });
  }

  /**
   * Log debug message (only in development)
   */
  static debug(message: string, data?: any): void {
    if (process.env.NODE_ENV !== 'production') {
      console.debug(`[DEBUG] ${message}`, data ? { data, timestamp: new Date().toISOString() } : { timestamp: new Date().toISOString() });
    }
  }
}
