import { type ArkErrors, type } from "arktype"
import { validationError } from "../api/errors"

const parseBody = <T>(schema: (data: unknown) => T | ArkErrors, body: unknown): T => {
  const parsed = schema(body)
  if (parsed instanceof type.errors) {
    throw validationError(parsed.summary)
  }
  return parsed
}

export { parseBody }
