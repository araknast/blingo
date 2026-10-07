// Same-origin API: forward to the blingo Worker over a service binding, so no CORS.
// blingo still checks the bearer token itself.
export default {
	fetch: (request, env) => env.BLINGO.fetch(request),
} satisfies ExportedHandler<Env>;
