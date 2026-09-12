export interface RealtimeEndpointResolution {
  configured: boolean;
  url?: string;
  issue?: "workspace_realtime_base_url_required" | "invalid_dashscope_base_url";
}

export function resolveRealtimeEndpoint(baseUrl: string, model: string): RealtimeEndpointResolution {
  try {
    const base = new URL(baseUrl);
    if (base.protocol !== "https:" || base.username || base.password) return { configured: false, issue: "invalid_dashscope_base_url" };
    if (!/\.maas\.aliyuncs\.com$/i.test(base.hostname)) {
      return { configured: false, issue: "workspace_realtime_base_url_required" };
    }
    const endpoint = new URL("/api/v1/webrtc/realtime", base.origin);
    endpoint.searchParams.set("model", model);
    return { configured: true, url: endpoint.toString() };
  } catch {
    return { configured: false, issue: "invalid_dashscope_base_url" };
  }
}
