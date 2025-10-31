type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/**
 * Simple structured logger with PII redaction
 */
class Logger {
  private level: LogLevel;
  private sensitiveFields = ['password', 'token', 'secret', 'authorization', 'credit_card'];

  constructor() {
    this.level = (process.env.LOG_LEVEL as LogLevel) || 'info';
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private redactSensitive(obj: any): any {
    if (typeof obj !== 'object' || obj === null) return obj;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const redacted: any = Array.isArray(obj) ? [] : {};

    for (const [key, value] of Object.entries(obj)) {
      if (this.sensitiveFields.some(field => key.toLowerCase().includes(field))) {
        redacted[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        redacted[key] = this.redactSensitive(value);
      } else {
        redacted[key] = value;
      }
    }

    return redacted;
  }

  private log(level: LogLevel, message: string, context?: LogContext): void {
    const logEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...this.redactSensitive(context || {}),
    };

    if (level === 'error') {
      console.error(JSON.stringify(logEntry));
    } else {
      console.warn(JSON.stringify(logEntry));
    }
  }

  debug(message: string, context?: LogContext): void {
    if (this.level === 'debug') {
      this.log('debug', message, context);
    }
  }

  info(message: string, context?: LogContext): void {
    if (['debug', 'info'].includes(this.level)) {
      this.log('info', message, context);
    }
  }

  warn(message: string, context?: LogContext): void {
    if (['debug', 'info', 'warn'].includes(this.level)) {
      this.log('warn', message, context);
    }
  }

  error(message: string, context?: LogContext): void {
    this.log('error', message, context);
  }
}

export const logger = new Logger();
