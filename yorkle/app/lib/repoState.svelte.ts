// A repository page's view of GET /repos/:repo, polled while the page is open.
import { onDestroy } from "svelte";
import { ApiError, api } from "./session.svelte";
import { toastError } from "./toast.svelte";
import type { RepoState } from "./types";
import { poll } from "./util";

export function repoState(repo: string, ms = 5000) {
	// `stale`: the last poll failed, so `data` may be out of date.
	const s = $state({ data: null as RepoState | null, missing: false, stale: false });
	async function refresh() {
		try {
			s.data = await api<RepoState>("GET", `/repos/${repo}`);
			s.stale = false;
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) s.missing = true;
			else if (!s.data) toastError(e);
			else s.stale = true;
		}
	}
	onDestroy(poll(refresh, ms));
	return {
		get data() {
			return s.data;
		},
		get missing() {
			return s.missing;
		},
		get stale() {
			return s.stale;
		},
		refresh,
	};
}
