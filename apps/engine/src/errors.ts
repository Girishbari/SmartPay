export class HttpError extends Error {
  constructor(public statusCode: number, message: string, public details?: unknown) {
    super(message);
  }
}
export const fail = (code: number, msg: string, details?: unknown): never => {
  throw new HttpError(code, msg, details);
};
