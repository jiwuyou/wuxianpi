import { NextResponse } from "next/server";
import type { ApiFailure, ApiResult, JsonValue } from "./contracts";

export class WuxianPiApiError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code?: string, public readonly details?: JsonValue) { super(message); }
}

export function apiSuccess<T>(data: T, init?: ResponseInit): NextResponse<ApiResult<T>> {
  return NextResponse.json({ success: true, data }, init);
}

export function apiFailure(error: unknown): NextResponse<ApiFailure> {
  const apiError = error instanceof WuxianPiApiError ? error : undefined;
  const nodeError = error as NodeJS.ErrnoException;
  const shaped = error as { status?: number; code?: string; details?: JsonValue };
  const message = error instanceof Error ? error.message : String(error);
  const invalid = /\b(invalid|unsafe|required|must|exceed|unsupported|cannot|missing)\b/i.test(message);
  const conflict = /\b(already exists|duplicate|conflict)\b/i.test(message);
  const notFound = /\b(not found|unknown)\b/i.test(message);
  const status = apiError?.status ?? shaped.status ?? (nodeError?.code === "ENOENT" || notFound ? 404 : nodeError?.code === "EEXIST" || conflict ? 409 : error instanceof SyntaxError || invalid ? 400 : 500);
  return NextResponse.json({ success: false, error: message, code: apiError?.code ?? shaped.code, details: apiError?.details ?? shaped.details }, { status });
}
