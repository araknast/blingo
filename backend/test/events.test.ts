import { expect, test } from "vitest";
import { pushOf } from "../src/events";

// The shape Artifacts delivered in the Phase 0 spike (trimmed).
const event = (repoName: string, type = "cf.artifacts.repo.pushed") => ({
	type,
	source: { namespace: "blingo", repoName, type: "artifacts.repo" },
	payload: { ref: "refs/heads/main", before: "b18e6a6", after: "05b6c0f", commits: [] },
});

test("a push to a fork's own repo names its repository, fork and new head", () => {
	expect(pushOf(event("r-1234abcd-f-deadbeef"))).toEqual({ repo: "r-1234abcd", fork: "r-1234abcd-f-deadbeef", head: "05b6c0f" });
});

test("anything else is ignored", () => {
	expect(pushOf(event("r-1234abcd"))).toBeNull(); // the base repo
	expect(pushOf(event("r-1234abcd-f-deadbeef", "cf.artifacts.repo.cloned"))).toBeNull();
	expect(pushOf("junk")).toBeNull();
	expect(pushOf(null)).toBeNull();
});
