import type { SecretMutationRequest, SecretSummary } from "@/lib/wuxianpi/contracts";
import { apiFailure, apiSuccess } from "@/lib/wuxianpi/api";
import { deleteSecret, listSecretRefs, setSecret } from "@/lib/wuxianpi/secret-store";

export async function GET() {
  try { return apiSuccess<{ secrets: SecretSummary[] }>({ secrets: (await listSecretRefs()).map((name) => ({ name, configured: true })) }); }
  catch (error) { return apiFailure(error); }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as SecretMutationRequest;
    if (body.value === undefined) await deleteSecret(body.name); else await setSecret(body.name, body.value);
    return apiSuccess<SecretSummary>({ name: body.name, configured: body.value !== undefined });
  } catch (error) { return apiFailure(error); }
}

export async function DELETE(request: Request) {
  try { const body = await request.json() as SecretMutationRequest; return apiSuccess({ name: body.name, deleted: await deleteSecret(body.name) }); }
  catch (error) { return apiFailure(error); }
}
