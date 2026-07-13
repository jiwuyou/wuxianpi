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
  const status = apiError?.status ?? (nodeError?.code === "ENOENT" ? 404 : nodeError?.code === "EEXIST" ? 409 : 500);
  return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error), code: apiError?.code, details: apiError?.details }, { status });
}
