// Artifacts `pushed` events, delivered to the EVENTS queue. Subscriptions exist per repo only (a
// namespace-wide one isn't accepted), so each loose fork gets its own while it can be pushed to.
// They need CF_API_TOKEN (Event Subscriptions edit); without it, loose forks are polled instead.

declare global {
	interface Env {
		CF_API_TOKEN?: string;
	}
}

const subscriptions = (env: Env, id = "") =>
	`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/event_subscriptions/subscriptions${id && `/${id}`}`;

// Subscribes the EVENTS queue to pushes to `repo`; returns the subscription id, or null when events
// aren't set up (or the call fails: the fork is then polled). A new subscription takes up to about a
// minute to deliver, so a push before that is only noticed by RepoDO's expiry check.
export async function subscribePushes(env: Env, repo: string): Promise<string | null> {
	if (!env.CF_API_TOKEN) return null;
	try {
		const r = await fetch(subscriptions(env), {
			method: "POST",
			headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({
				name: repo,
				enabled: true,
				source: { type: "artifacts.repo", namespace: "blingo", repo_name: repo },
				destination: { type: "queues.queue", queue_id: env.EVENTS_QUEUE_ID },
				events: ["pushed"],
			}),
		});
		const body = (await r.json()) as { success: boolean; result?: { id: string }; errors?: unknown };
		if (!body.success) throw new Error(JSON.stringify(body.errors));
		return body.result!.id;
	} catch (e) {
		console.error(`subscribing to pushes to ${repo}`, e);
		return null;
	}
}

export async function unsubscribe(env: Env, id: string | null) {
	if (!id || !env.CF_API_TOKEN) return;
	await fetch(subscriptions(env, id), { method: "DELETE", headers: { authorization: `Bearer ${env.CF_API_TOKEN}` } }).catch((e) =>
		console.error(`unsubscribing ${id}`, e),
	);
}

// A queue message → the fork that was pushed to and its new head, if it is a push to a fork's own repo.
export function pushOf(body: unknown): { repo: string; fork: string; head: string } | null {
	const b = body as { type?: string; source?: { repoName?: string }; payload?: { after?: string } };
	const fork = b?.source?.repoName;
	const head = b?.payload?.after;
	if (b?.type !== "cf.artifacts.repo.pushed" || !fork || !head || !fork.includes("-f-")) return null;
	return { repo: fork.split("-f-")[0], fork, head };
}
