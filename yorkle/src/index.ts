// Same-origin API: /api/* is forwarded to the blingo Worker (prefix stripped) over a service
// binding, so no CORS. /verify passes through as is. blingo still checks the bearer token itself.
export default {
	fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/api/")) url.pathname = url.pathname.slice("/api".length);
		return env.BLINGO.fetch(new Request(url, request));
	},
} satisfies ExportedHandler<Env>;
