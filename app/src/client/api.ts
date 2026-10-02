// Thin fetch wrapper. Holder sessions live in sessionStorage (cleared with the
// tab); staff keys in localStorage on that staff device.

const SESSION_KEY = "nokor.session";
const STAFF_KEY = "nokor.staffKey";

function safe<T>(f: () => T, fallback: T): T {
  try {
    return f();
  } catch {
    return fallback;
  }
}

export const session = {
  get: () => safe(() => sessionStorage.getItem(SESSION_KEY), null),
  set: (t: string | null) =>
    safe(() => (t ? sessionStorage.setItem(SESSION_KEY, t) : sessionStorage.removeItem(SESSION_KEY)), undefined),
};

export const staffKey = {
  get: () => safe(() => localStorage.getItem(STAFF_KEY), null),
  set: (t: string | null) => safe(() => (t ? localStorage.setItem(STAFF_KEY, t) : localStorage.removeItem(STAFF_KEY)), undefined),
};

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body: unknown, token: string | null): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

/** As the signed-in holder or merchant. */
export const api = {
  get: <T>(p: string) => call<T>("GET", p, undefined, session.get()),
  post: <T>(p: string, b: unknown = {}) => call<T>("POST", p, b, session.get()),
  put: <T>(p: string, b: unknown) => call<T>("PUT", p, b, session.get()),
};

/** As staff (immigration, gate, operator). */
export const staffApi = {
  get: <T>(p: string) => call<T>("GET", p, undefined, staffKey.get()),
  post: <T>(p: string, b: unknown = {}) => call<T>("POST", p, b, staffKey.get()),
};
