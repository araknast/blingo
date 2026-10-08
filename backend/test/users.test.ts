import { expect, test } from "vitest";
import { checkPassword, hashPassword, invalidSignup } from "../src/auth";

test("password hash round-trips and rejects wrong passwords", async () => {
	const { hash, salt } = await hashPassword("correct horse");
	expect(await checkPassword("correct horse", hash, salt)).toBe(true);
	expect(await checkPassword("correct horsf", hash, salt)).toBe(false);
	expect((await hashPassword("correct horse")).hash).not.toBe(hash); // fresh salt each time
});

test("signup validation", () => {
	const ok = { invite: "abc", username: "kofi_1", email: "k@example.com", password: "12345678" };
	expect(invalidSignup(ok)).toBeNull();
	expect(invalidSignup({ ...ok, invite: "" })).toMatch(/invite/);
	expect(invalidSignup({ ...ok, username: "Kofi" })).toMatch(/username/);
	expect(invalidSignup({ ...ok, username: "a" })).toMatch(/username/);
	expect(invalidSignup({ ...ok, email: "nope" })).toMatch(/email/);
	expect(invalidSignup({ ...ok, password: "short" })).toMatch(/password/);
	expect(invalidSignup({ ...ok, password: 12345678 as unknown as string })).toMatch(/password/);
});
