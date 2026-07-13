import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { assistantIdFromCwd } from "@/lib/wuxianpi/paths";

export async function GET() {
  try {
    const sessions = (await listAllSessions()).map((session) => ({
      ...session,
      assistantId: assistantIdFromCwd(session.cwd),
    }));
    return NextResponse.json({ sessions });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
