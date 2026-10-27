/** Narrow HTTP surface: no account-management or public signup endpoints. */
export async function handleAuthRequest(
  request: Request,
  auth: { handler(request: Request): Promise<Response> },
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const methods: Record<string, string> = {
    "/api/auth/register-invitation": "POST",
    "/api/auth/sign-in/email": "POST",
    "/api/auth/sign-out": "POST",
    "/api/auth/get-session": "GET",
  };
  if (!methods[path]) return Response.json({ error: "Not found" }, { status: 404 });
  if (request.method !== methods[path]) return Response.json({ error: "Method not allowed" }, { status: 405 });
  try {
    if (request.body) {
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16_384) {
          await reader.cancel();
          return Response.json({ error: "Request too large" }, { status: 413 });
        }
        chunks.push(value);
      }
      request = new Request(request.url, {
        method: request.method, headers: request.headers, body: Buffer.concat(chunks),
      });
    }
    const response = await auth.handler(request);
    if (!response.ok) {
      const headers = new Headers({ "cache-control": "no-store" });
      const retryAfter = response.headers.get("retry-after");
      const xRetryAfter = response.headers.get("x-retry-after");
      if (xRetryAfter !== null) headers.set("x-retry-after", xRetryAfter);
      if (retryAfter !== null || xRetryAfter !== null) {
        headers.set("retry-after", retryAfter ?? xRetryAfter!);
      }
      return Response.json({ error: "Authentication request failed" }, { status: response.status, headers });
    }
    response.headers.set("cache-control", "no-store");
    return response;
  } catch {
    return Response.json({ error: "Authentication temporarily unavailable" }, { status: 503 });
  }
}
