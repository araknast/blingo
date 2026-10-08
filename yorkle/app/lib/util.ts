// Fork names are `<repo>-f-<id>`; the id alone is enough inside a repository.
export const short = (fork: string) => fork.split("-f-")[1] ?? fork;

export function ago(ms: number) {
	const s = Math.max(0, (Date.now() - ms) / 1000);
	if (s < 45) return "just now";
	if (s < 90) return "a minute ago";
	if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
	if (s < 5400) return "an hour ago";
	if (s < 86400) return `${Math.round(s / 3600)} hours ago`;
	if (s < 172800) return "yesterday";
	if (s < 30 * 86400) return `${Math.round(s / 86400)} days ago`;
	return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function duration(ms: number) {
	const m = Math.round(ms / 60000);
	return m < 1 ? "under a minute" : m === 1 ? "1 minute" : m < 60 ? `${m} minutes` : `${(m / 60).toFixed(1)} hours`;
}

export const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

export async function copy(text: string) {
	await navigator.clipboard.writeText(text);
}

// Calls fn now and every `ms` while the tab is visible. Returns a stop function.
export function poll(fn: () => unknown, ms: number) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	const run = async () => {
		clearTimeout(timer);
		if (stopped) return;
		if (document.visibilityState === "visible") await fn();
		if (!stopped) timer = setTimeout(run, ms);
	};
	const onVisible = () => document.visibilityState === "visible" && run();
	document.addEventListener("visibilitychange", onVisible);
	run();
	return () => {
		stopped = true;
		clearTimeout(timer);
		document.removeEventListener("visibilitychange", onVisible);
	};
}

// How to open the map's menu on this device.
export const menuGesture = matchMedia("(pointer: coarse)").matches ? "Press and hold" : "Right-click";

export const firstLine =(s: string) => s.split("\n", 1)[0];

// Agent run status → what the UI calls it.
export const agentLabel = (status: string) =>
	({ running: "Working", placed: "Done", planned: "Tasks added", failed: "Failed", lost: "Failed: sandbox lost" })[status] ?? status;
