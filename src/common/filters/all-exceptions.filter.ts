import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

// Express body-parser rejections (too large, bad JSON) are client errors, not 500s.
// Fixed messages: the parser's own text can echo the request body.
const PARSER_MESSAGES: Record<string, string> = {
  'entity.too.large': 'Request body is too large',
  'entity.parse.failed': 'Request body is not valid JSON',
};

function bodyParserError(e: unknown): { status: number; message: string } | null {
  const err = e as { type?: string; status?: number } | null;
  if (!err?.type || !(err.type in PARSER_MESSAGES) || typeof err.status !== 'number') return null;
  return { status: err.status, message: PARSER_MESSAGES[err.type] };
}

// Uniform, safe error responses — never leak stack traces, SQL, or internals.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();

    const parser = bodyParserError(exception);
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : (parser?.status ?? HttpStatus.INTERNAL_SERVER_ERROR);

    let message: string | string[] = parser?.message ?? 'Internal server error';
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      message =
        typeof body === 'string'
          ? body
          : ((body as { message?: string | string[] }).message ?? exception.message);
    }

    const requestId = req.id ?? req.headers['x-request-id'];
    if (status >= 500) {
      // The request id is what the caller sees, so the log line can be found from it.
      this.logger.error(
        `${req.method} ${req.originalUrl ?? req.url} requestId=${String(requestId)}\n` +
          (exception instanceof Error ? exception.stack : String(exception)),
      );
    }

    res.status(status).json({
      statusCode: status,
      error: HttpStatus[status] ?? 'Error',
      message,
      requestId,
    });
  }
}
