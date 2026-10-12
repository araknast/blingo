// Runs the engine for two simulated hours and checks its bookkeeping holds together.
const assert = require("node:assert");
const e = require("./engine.cjs");

for (const opts of [{}, { parallel: true, agents: 500, modules: 48 }]) {
	const w = e.createWorld(7, opts);
	e.step(w, 2 * 3600);
	const c = e.census(w);
	assert(c.running + c.ci + c.placing <= w.opts.agents, "never more agents at work than the target");
	assert(w.stats.placed > 0 && w.bubbles.size > 0, "forks get placed into bubbles");
	assert(w.ops.length <= (w.opts.parallel ? 12 : 1), "merge loop respects its limit");
	for (const b of w.bubbles.values()) {
		assert(b.members >= 1 && b.nMerged <= b.members, `${b.name}: member counts add up`);
		if (!b.visible) assert(w.ops.some((o) => o.a === b.id || o.b === b.id), `${b.name}: hidden only while merging`);
	}
	for (const { a, b } of w.conflicts.values()) assert(w.bubbles.has(a) && w.bubbles.has(b), "conflicts name live bubbles");
	console.log("ok", JSON.stringify(opts), `${w.bubbles.size} bubbles, ${w.stats.merges} merges`);
}
