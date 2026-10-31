export class AppError extends Error {
  code: string;
  status: number;
  detail?: string;

  constructor(code: string, message: string, status = 400, detail?: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}
