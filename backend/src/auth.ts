// Pure account helpers (WebCrypto only), kept out of UsersDO so they unit-test without Workers.

export type Signup = { invite: string; username: string; email: string; password: string };

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));

// Error message, or null when the signup fields are acceptable.
export function invalidSignup(s: Partial<Signup>): string | null {
	if (typeof s.invite !== "string" || !s.invite) return "invite required";
	if (typeof s.username !== "string" || !/^[a-z0-9_-]{2,32}$/.test(s.username)) return "username: 2-32 of a-z 0-9 _ -";
	if (typeof s.email !== "string" || s.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email)) return "invalid email";
	if (typeof s.password !== "string" || s.password.length < 8 || s.password.length > 1024) return "password: 8-1024 characters";
	return null;
}

// PBKDF2-SHA256 at 100k iterations, the most Workers allows.
export async function hashPassword(password: string, salt = hex(crypto.getRandomValues(new Uint8Array(16)))) {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 100_000 },
		key,
		256,
	);
	return { hash: hex(bits), salt };
}

export async function checkPassword(password: string, hash: string, salt: string): Promise<boolean> {
	const got = (await hashPassword(password, salt)).hash;
	let diff = got.length ^ hash.length;
	for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ hash.charCodeAt(i);
	return diff === 0;
}
