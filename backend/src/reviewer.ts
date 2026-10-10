import Anthropic from "@anthropic-ai/sdk";
import { Agent } from "agents";

// Automatic review, part of CI when a repository asks for it: one Reviewer agent per loose fork reads
// the task and the fork's patch series and approves or rejects it, then reports to the RepoDO.
export type ReviewJob = { repo: string; fork: string; head: string; title: string; description: string; series: string };
type State = { fork?: string; head?: string; verdict?: "approved" | "rejected"; comments?: string };

const SYSTEM = `You review a change before it is merged into a shared repository. You get the task it was made for and its commits as a git format-patch series.
Approve it if it does what the task asks, doesn't break or delete unrelated things, and has no obvious bugs or security problems. Style alone is never a reason to reject.
If you reject it, say exactly what must change: your comments go to whoever fixes it.`;

const VERDICT = {
	type: "object",
	properties: { approve: { type: "boolean" }, comments: { type: "string" } },
	required: ["approve", "comments"],
	additionalProperties: false,
} as const;

export class Reviewer extends Agent<Env, State> {
	initialState: State = {};

	// Queues the review (the agent's schedule runs it, with retries) and returns at once.
	async start(job: ReviewJob) {
		this.setState({ fork: job.fork, head: job.head });
		await this.schedule(0, "run", job, { retry: { maxAttempts: 3 } });
	}

	async run(job: ReviewJob) {
		let approve = false;
		let comments: string;
		try {
			({ approve, comments } = await this.verdict(job));
		} catch (e) {
			// ponytail: an API failure counts as a rejection (a fixer may run for nothing); add a retry
			// endpoint if reviews fail often.
			comments = `The automatic review could not run: ${e instanceof Error ? e.message : String(e)}`;
		}
		this.setState({ fork: job.fork, head: job.head, verdict: approve ? "approved" : "rejected", comments });
		await this.env.REPO.getByName(job.repo).reviewDone(job.fork, job.head, approve, comments);
	}

	private async verdict(job: ReviewJob): Promise<{ approve: boolean; comments: string }> {
		const client = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
		const r = await client.beta.messages.create({
			model: this.env.MODEL,
			max_tokens: 16000,
			// A safety decline is re-run on Anthropic's recommended fallback model instead of failing the review.
			betas: ["server-side-fallback-2026-07-01"],
			fallbacks: "default",
			output_config: { effort: "high", format: { type: "json_schema", schema: VERDICT } },
			system: SYSTEM,
			messages: [{ role: "user", content: `# ${job.title}\n\n${job.description}\n\n<patch-series>\n${job.series}\n</patch-series>` }],
		});
		if (r.stop_reason === "refusal") return { approve: false, comments: "The reviewer declined to review this change." };
		const text = r.content.find((b) => b.type === "text");
		if (!text || text.type !== "text") throw new Error(`no verdict (stop reason ${r.stop_reason})`);
		const v = JSON.parse(text.text) as { approve: boolean; comments: string };
		return { approve: v.approve === true, comments: String(v.comments ?? "") };
	}
}
