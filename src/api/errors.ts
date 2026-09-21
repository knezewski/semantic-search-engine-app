class AppError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = "AppError"
    this.code = code
    this.status = status
  }
}

const validationError = (message: string): AppError => new AppError("VALIDATION_ERROR", message, 400)

const notFoundError = (message: string): AppError => new AppError("NOT_FOUND", message, 404)

const notReadyError = (message: string): AppError => new AppError("NOT_READY", message, 503)

type ErrorBody = {
  error: {
    code: string
    message: string
  }
}

const toErrorBody = (error: unknown): { body: ErrorBody; status: number } => {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message } }
    }
  }

  // Malformed request JSON (c.req.json()) should be a client error, not a 500.
  if (error instanceof SyntaxError) {
    return {
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: "Invalid JSON body" } }
    }
  }

  return {
    status: 500,
    body: {
      error: {
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "Unexpected error"
      }
    }
  }
}

export { AppError, notFoundError, notReadyError, toErrorBody, validationError }
