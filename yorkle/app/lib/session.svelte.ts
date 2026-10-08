import { navigate } from "./router.svelte";
import type { Me } from "./types";

// The bearer is a session token from /login, or a pasted API token. Same key the old UI used.
const KEY = "blingo-token";
function stored() {
	try {
		return localStorage.getItem(KEY) ?? "";
	} catch {
		return "";
	}
}

export const session = $state({ token: stored(), me: null as Me | null, checked: false });

export function setToken(token: string) {
	session.token = token;
	try {
		if (token) localStorage.setItem(KEY, token);
		else localStorage.removeItem(KEY);
	} catch {}
}

export class ApiError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

// Raw response from blingo, via yorkle's /api prefix. A 401 ends the session.
export async function request(method: string, path: string, body?: unknown): Promise<Response> {
	const res = await fetch(`/api${path}`, {
		method,
		headers: { authorization: `Bearer ${session.token}`, ...(body ? { "content-type": "application/json" } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (res.status === 401 && session.token && path !== "/login") {
		setToken("");
		session.me = null;
		navigate("/login", true);
	}
	if (!res.ok) {
		const text = await res.text();
		let msg = text.trim() || res.statusText;
		try {
			msg = JSON.parse(text).error ?? msg;
		} catch {}
		throw new ApiError(msg, res.status);
	}
	return res;
}

export const api = async <T = any>(method: string, path: string, body?: unknown): Promise<T> =>
	(await request(method, path, body)).json();

export async function loadMe() {
	session.me = session.token ? await api<Me>("GET", "/me").catch(() => null) : null;
	session.checked = true;
}

export async function logout() {
	await api("POST", "/logout").catch(() => {});
	setToken("");
	session.me = null;
	navigate("/");
}
