// History-API routing: `route` follows the URL; same-origin <a> clicks navigate without reloading.

export const route = $state({ path: location.pathname, search: location.search });

function sync() {
	route.path = location.pathname;
	route.search = location.search;
}

export function navigate(to: string, replace = false) {
	history[replace ? "replaceState" : "pushState"](null, "", to);
	sync();
	if (!replace) window.scrollTo(0, 0);
}

addEventListener("popstate", sync);
addEventListener("click", (e) => {
	if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
	const a = (e.target as Element).closest?.("a"); // HTML or SVG <a>
	const href = a?.getAttribute("href");
	if (!a || href == null || a.getAttribute("target") || a.hasAttribute("download")) return;
	const url = new URL(href, location.href);
	if (url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname === "/verify") return;
	e.preventDefault();
	navigate(url.pathname + url.search + url.hash);
});

// "/repos/:repo/b/:bubble/src/*" → params, with the rest of the path under "*".
export function match(pattern: string, path: string): Record<string, string> | null {
	const p = pattern.split("/");
	const s = path.split("/");
	const out: Record<string, string> = {};
	for (let i = 0; i < p.length; i++) {
		if (p[i] === "*") {
			out["*"] = s.slice(i).map(decodeURIComponent).join("/");
			return out;
		}
		if (s[i] === undefined) return null;
		if (p[i].startsWith(":")) out[p[i].slice(1)] = decodeURIComponent(s[i]);
		else if (p[i] !== s[i]) return null;
	}
	return s.length === p.length ? out : null;
}
