// Runs the engine for two simulated hours and checks its bookkeeping holds together.
const assert = require("node:assert");
const e = require("./engine.cjs");

for (const opts of [{}, { parallel: false, agents: 500, modules: 48 }]) {
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

// Stopped superagents start nothing new: every agent they started finishes, and with parallel merges and
// ferge agents that never fail, the repository settles to one unlocked bubble with no conflicts.
for (const opts of [{}, { agents: 500, modules: 48 }]) {
	const w = e.createWorld(7, opts);
	e.step(w, 3600);
	w.opts.stopped = true;
	e.step(w, 4 * 3600);
	const left = [...w.agents.values()].filter((a) => e.working(a) && a.role === "agent").length;
	assert.strictEqual(left, 0, "no superagent agents at work after draining");
	const bs = [...w.bubbles.values()];
	assert.strictEqual(bs.length, 1, `settles to one bubble (has ${bs.length}: ${bs.map((b) => b.name).join(", ")})`);
	assert.strictEqual(w.conflicts.size, 0, "no conflicts left");
	assert(!bs[0].locked && bs[0].visible, "the bubble is unlocked and idle");
	console.log("ok stopped", JSON.stringify(opts), `settled to ${bs[0].name}, ${fmt(bs[0].members)} forks`);
}

function fmt(n) { return n.toLocaleString("en-US"); }
