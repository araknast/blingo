import { expect, test } from "vitest";
import { fergeName, friendlyName, nameText, repoName } from "../src/names";

test("friendly names are an adjective and a noun", () => {
	const n = friendlyName(() => 0);
	expect(n).toEqual({ adj: "amber", noun: "badger" });
	expect(nameText(n)).toBe("amber badger");
	expect(friendlyName(() => 0.9999).adj).toBe("witty");
});

test("a repository's first bubble is called after it", () => {
	expect(nameText({ adj: "", noun: "blingo" })).toBe("blingo");
});

test("ferge bubbles join both names, nouns run together", () => {
	expect(fergeName({ adj: "swift", noun: "otter" }, { adj: "calm", noun: "river" })).toBe("swift calm otterriver ferge");
	expect(fergeName({ adj: "", noun: "blingo" }, { adj: "calm", noun: "river" })).toBe("calm blingoriver ferge");
});

test("repository names are trimmed and limited", () => {
	expect(repoName("  my   repo ")).toBe("my repo");
	expect(repoName("")).toBeNull();
	expect(repoName("x".repeat(61))).toBeNull();
	expect(repoName(42)).toBeNull();
});
