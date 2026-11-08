const ACCESS_HEADERS = ["CF-Access-Client-Id", "CF-Access-Client-Secret"] as const;

export function stripAccessHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const name of ACCESS_HEADERS) headers.delete(name);
  // This hostname is a machine-to-machine API. If an interactive Access policy
  // is ever added, its CF_Authorization JWT would otherwise ride inside Cookie
  // all the way to an untrusted rental host. ComfyUI does not need cookies.
  headers.delete("Cookie");
  return headers;
}

const worker = {
  async fetch(request: Request): Promise<Response> {
    // Cloudflare Access authenticates the incoming request before this Worker.
    // The route then proxies to the existing Tunnel origin without the
    // long-lived service-token credentials. The signed Access assertion must
    // remain: Cloudflare validates it again on the Tunnel leg. It is scoped to
    // this application and expires, unlike the reusable client secret.
    return fetch(new Request(request, { headers: stripAccessHeaders(request.headers) }));
  },
};

export default worker;
