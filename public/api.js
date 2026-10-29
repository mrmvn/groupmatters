// API client. The space token lives in the page path (/s/<token>); requests go to /api/s/<token>/…

const m = /^\/s\/([A-Za-z0-9_-]+)/.exec(location.pathname);
export const TOKEN = m ? m[1] : "";
const BASE = `/api/s/${TOKEN}`;

export const getName = () => localStorage.getItem("qr:name") || "";
export const setName = (n) => localStorage.setItem("qr:name", n.trim());

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function api(method, path, body) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const name = getName();
  if (name) headers["X-Actor-Name"] = encodeURIComponent(name);
  let res;
  try {
    res = await fetch(`${BASE}/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), referrerPolicy: "no-referrer" });
  } catch {
    throw new ApiError(0, "network", "Can't reach the server. Check your connection.");
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new ApiError(res.status, "bad_response", `Unexpected server response (${res.status})`);
  }
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? "error", data?.error?.message ?? "Request failed", data?.error?.details);
  return data;
}

export const qs = (params) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
};
