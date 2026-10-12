// ---- Engine: blingo's placement and merge rules, simulated. Pure: no DOM. ----
const MODULES = [
	"src/billing", "src/auth", "src/search", "src/notify", "src/reports", "src/api", "src/importers", "src/payments",
	"src/sync", "src/workers", "src/db", "src/cache", "src/flags", "src/audit", "src/geo", "src/media",
	"web/components", "web/pages", "web/editor", "web/settings", "web/charts", "web/i18n", "web/onboarding", "web/admin",
	"cli", "docs", "infra", "test/e2e", "sdk/python", "sdk/go", "mobile/ios", "mobile/android",
	"src/teams", "src/invites", "src/export", "src/webhooks", "src/ratelimit", "src/sessions", "src/tax", "src/ledger",
	"web/table", "web/forms", "web/nav", "web/theme", "web/upload", "web/search", "web/billing", "web/reports",
];
const LEAF0 = ["index.ts", "types.ts", "store.ts", "client.ts", "utils.ts", "handlers.ts", "schema.ts", "view.ts", "queue.ts", "cache.ts",
	"retry.ts", "format.ts", "validate.ts", "errors.ts", "config.ts", "events.ts", "model.ts", "service.ts", "mapper.ts", "index.test.ts"];
const LEAVES = [...LEAF0, ...LEAF0.map((l) => `internal/${l}`)];
// Files nearly every change ends up touching.
// Files nearly every change ends up touching.
const HOT = ["src/routes.ts", "src/db/schema.ts", "web/app.ts", "package.json", "src/index.ts", "CHANGELOG.md"];
const AREAS = ["services", "packages", "apps", "libs"];

// The repository's file tree: `modules` folders of LEAVES, then the hot files. Bitsets are sized to it.
function makeRepo(modules) {
	const mods = Array.from({ length: modules }, (_, i) => (i < MODULES.length ? MODULES[i] : `${AREAS[i % 4]}/${NOUN[i % NOUN.length]}-${Math.floor(i / 4)}`));
	const files = [...mods.flatMap((m) => LEAVES.map((l) => `${m}/${l}`)), ...HOT];
	const modW = mods.map((_, i) => 1 / Math.pow(i + 1, 0.6));
	return { mods, files, nf: files.length, hot0: files.length - HOT.length, words: Math.ceil(files.length / 32), modW, modSum: modW.reduce((a, b) => a + b, 0) };
}

const ADJ = ["amber", "brisk", "calm", "clever", "cosy", "crisp", "dapper", "eager", "fancy", "gentle", "glossy", "jolly", "keen", "lively",
	"lucky", "mellow", "merry", "nimble", "plucky", "quiet", "rosy", "rustic", "snappy", "spry", "sunny", "swift", "tidy", "witty"];
const NOUN = ["badger", "beacon", "breeze", "comet", "cove", "falcon", "fern", "harbor", "heron", "lantern", "maple", "meadow", "otter", "pebble",
	"pine", "puffin", "quill", "river", "robin", "sparrow", "spruce", "tide", "thistle", "walrus", "willow", "wren"];
const VERBS = ["Add retries to", "Fix the flaky test for", "Refactor", "Speed up", "Document", "Add logging to", "Handle errors in", "Cache",
	"Validate input to", "Split up", "Remove dead code from", "Type the", "Add metrics to", "Paginate"];

function mulberry32(a) {
	return () => {
		a |= 0; a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const pop = (x) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0xf0f0f0f) * 0x1010101) >>> 24; };
const has = (bits, f) => (bits[f >>> 5] >>> (f & 31)) & 1;
const set = (bits, f) => (bits[f >>> 5] |= 1 << (f & 31));
const overlap = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) n += pop(a[i] & b[i]); return n; };
const count = (a) => { let n = 0; for (let i = 0; i < a.length; i++) n += pop(a[i]); return n; };
const bitsOf = (a) => { const out = []; for (let i = 0; i < a.length; i++) { let w = a[i]; while (w) { const j = 31 - Math.clz32(w & -w); out.push(i * 32 + j); w &= w - 1; } } return out; };

const DEFAULTS = { agents: 2000, ci: true, autoFerge: true, fergeAgents: true, person: false, parallel: false, modules: 240, maxAgentPushes: 3, repo: "orchard" };

function createWorld(seed = 7, opts = {}) {
	const o = { ...DEFAULTS, ...opts };
	return {
		rng: mulberry32(seed), opts: o, repo: makeRepo(o.modules),
		t: 0, seq: 0, nextAlarm: 0, nextPerson: 0, nextSample: 0, nid: 0, nb: 0,
		bubbles: new Map(), renamed: new Map(), conflicts: new Map(), requested: new Set(),
		agents: new Map(), ops: [], events: [],
		stats: { placed: 0, merges: 0, conflicts: 0, ferges: 0, newBubbles: 0, applied: 0 },
		placeLog: [],
		history: [],
	};
}

const hex = (w) => Math.floor(w.rng() * 0xffffffff).toString(16).padStart(8, "0");
const pick = (w, xs) => xs[Math.floor(w.rng() * xs.length)];
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const resolve = (w, id) => { while (id && !w.bubbles.has(id) && w.renamed.has(id)) id = w.renamed.get(id); return id && w.bubbles.has(id) ? id : null; };

function newBubble(w, repId, extra = {}) {
	const first = w.nb === 0;
	const adj = first ? "" : pick(w, ADJ), noun = first ? w.opts.repo : pick(w, NOUN);
	const b = {
		id: repId, n: w.nb++, adj, noun, name: adj ? `${adj} ${noun}` : noun, visible: true, locked: false, ferge: false, fixed: false,
		files: new Uint32Array(w.repo.words), own: new Uint32Array(w.repo.words), last: new Float64Array(w.repo.nf), epoch: 0,
		queue: [], applying: [], boxUntil: 0, nMerged: 0, nFailed: 0, members: 1, recent: [], created: w.t,
		film: (repId.charCodeAt(repId.length - 1) + repId.charCodeAt(repId.length - 2)) % 4, fergeAgent: null, personFix: 0, hiddenBy: null,
		...extra,
	};
	w.bubbles.set(b.id, b);
	w.stats.newBubbles++;
	w.events.push({ type: "bubble", id: b.id });
	return b;
}

function forkFiles(w) {
	const R = w.repo;
	let r = w.rng() * R.modSum, m = 0;
	while (r > R.modW[m] && m < R.mods.length - 1) r -= R.modW[m++];
	const n = 1 + Math.floor(Math.pow(w.rng(), 1.6) * 5);
	const fs = new Set();
	while (fs.size < n) fs.add(m * LEAVES.length + Math.floor(Math.pow(w.rng(), 1.3) * LEAVES.length));
	if (w.rng() < 0.08) fs.add(R.hot0 + Math.floor(Math.pow(w.rng(), 1.5) * HOT.length));
	const leaf = LEAVES[[...fs][0] % LEAVES.length].replace(/^internal\//, "").replace(/\.(test\.)?ts$/, "");
	return { files: [...fs], mod: m, title: `${pick(w, VERBS)} ${leaf} in ${R.mods[m].split("/").pop()}` };
}

// Where a new agent forks from: mostly the biggest bubble, like a task with no bubble given.
function chooseBasis(w) {
	let best = null, vis = [];
	for (const b of w.bubbles.values()) {
		if (!b.visible || b.ferge) continue;
		vis.push(b);
		if (!best || b.members > best.members) best = b;
	}
	if (!best) return null;
	return w.rng() < 0.7 ? best : pick(w, vis);
}

function startAgent(w, o = {}) {
	const f = o.files ? { files: o.files, mod: -1, title: o.title } : forkFiles(w);
	const basis = o.basis ?? chooseBasis(w);
	const id = `r-${w.opts.repo}-f-${hex(w)}`;
	const a = {
		id, title: f.title, files: f.files, role: o.role ?? "agent", state: "running", person: false, why: "",
		basis: basis ? basis.id : null, basisEpoch: basis ? basis.epoch : 0, basisT: w.t, pushes: 0, started: w.t,
		until: w.t + (o.role === "ferge" ? 300 + w.rng() * 600 : 360 + Math.pow(w.rng(), 1.5) * 1440),
	};
	w.agents.set(id, a);
	return a;
}

const working = (a) => !a.person && (a.state === "running" || a.state === "ci" || a.state === "review" || a.state === "placing");

function toPerson(w, a, why) { a.person = true; a.state = "person"; a.why = why; a.since = w.t; }

function advanceAgent(w, a) {
	const { rng, opts } = w;
	if (a.state === "running") {
		if (a.role === "agent" && a.pushes === 0 && !a.fixing && rng() < 0.03) { a.state = "failed"; a.person = true; a.why = "Agent failed. Retry it from its task"; a.since = w.t; return; }
		if (a.role === "ferge" && rng() < 0.08) { failFergeAgent(w, a); return; }
		a.fixing = false;
		if (opts.ci) { a.state = "ci"; a.until = w.t + 120 + rng() * 240; }
		else { a.state = "placing"; a.until = w.t + 15 + rng() * 30; }
	} else if (a.state === "ci") {
		if (rng() < 0.15) return failGate(w, a, "CI failed");
		a.state = "review"; a.until = w.t + 60 + rng() * 90;
	} else if (a.state === "review") {
		if (rng() < 0.07) return failGate(w, a, "Review rejected");
		a.state = "placing"; a.until = w.t + 15 + rng() * 30;
	} else if (a.state === "placing") place(w, a);
}

function failGate(w, a, why) {
	a.pushes++;
	if (a.pushes >= w.opts.maxAgentPushes) return toPerson(w, a, why);
	a.state = "running"; a.fixing = true; a.until = w.t + 180 + w.rng() * 420; // a fixer run on the same fork
}

function failFergeAgent(w, a) {
	const b = w.bubbles.get(resolve(w, a.basis));
	if (b) b.fergeAgent = null;
	w.agents.delete(a.id);
}

// RepoDO.place / placeFork: home first, then the first bubble neither it nor the basis touched those files in.
function place(w, a) {
	w.agents.delete(a.id);
	if (w.rng() < 0.02 && a.role === "agent") return; // changed nothing: joins no bubble
	const home = w.bubbles.get(resolve(w, a.basis)) ?? null;
	const fitsHome = home && home.visible && home.epoch === a.basisEpoch && a.files.every((f) => home.last[f] <= a.basisT);
	let into = fitsHome ? home : null;
	if (!into && home && home.ferge) { if (a.role === "ferge") { home.fergeAgent = null; } toPerson(w, a, "A ferge fix that no longer fits"); w.agents.set(a.id, a); return; }
	if (!into) for (const b of w.bubbles.values()) {
		if (b === home || !b.visible || b.ferge) continue;
		if (a.files.every((f) => !has(b.files, f) && !(home && has(home.files, f)))) { into = b; break; }
	}
	w.stats.placed++;
	const why = into ? (into === home ? "home" : "other") : !home ? "nobasis" : !home.visible ? "hidden" : home.epoch !== a.basisEpoch ? "epoch" : "changed";
	w.placeLog.push([w.t, why]);
	if (!into) {
		const b = newBubble(w, a.id);
		for (const f of a.files) { set(b.files, f); set(b.own, f); b.last[f] = w.t; }
		if (home) for (let i = 0; i < b.files.length; i++) b.files[i] |= home.files[i];
		b.recent.push(a.id);
		return;
	}
	into.queue.push({ id: a.id, role: a.role });
	into.members++;
	into.recent.push(a.id);
	if (into.recent.length > 8) into.recent.shift();
	for (const f of a.files) { set(into.files, f); set(into.own, f); into.last[f] = w.t; }
	w.events.push({ type: "join", id: into.id, fork: a.id });
}

const idle = (w, b) => b.visible && b.queue.length === 0 && b.applying.length === 0 && b.boxUntil <= w.t;

// Files both changed since the younger split off: where a textual conflict can happen.
function contested(a, b) {
	const [old, young] = a.created <= b.created ? [a, b] : [b, a];
	const both = new Uint32Array(a.own.length);
	for (let i = 0; i < both.length; i++) both[i] = a.own[i] & b.own[i];
	return bitsOf(both).filter((f) => old.last[f] > young.created);
}

function absorb(w, a, b) {
	for (let i = 0; i < a.files.length; i++) { a.files[i] |= b.files[i]; a.own[i] |= b.own[i]; }
	for (let f = 0; f < a.last.length; f++) if (b.last[f] > a.last[f]) a.last[f] = b.last[f];
	a.epoch++;
	a.members += b.members;
	a.nMerged += b.nMerged + 1;
	a.nFailed += b.nFailed;
	a.recent = [...a.recent, b.id].slice(-8);
	w.renamed.set(b.id, a.id);
	for (const [k, v] of [...w.conflicts]) {
		if (v.a !== b.id && v.b !== b.id) continue;
		w.conflicts.delete(k);
		const other = v.a === b.id ? v.b : v.a;
		if (other !== a.id && !w.conflicts.has(pairKey(a.id, other))) w.conflicts.set(pairKey(a.id, other), { a: a.id, b: other, since: v.since });
	}
	w.bubbles.delete(b.id);
	w.events.push({ type: "absorb", id: a.id, gone: b.id });
}

function pickMerge(w, busy) {
	const free = [...w.bubbles.values()].filter((b) => idle(w, b) && !b.locked && !busy.has(b.id));
	for (const a of free) {
		let best = null, bd = Infinity;
		for (const b of free) {
			if (b === a || w.conflicts.has(pairKey(a.id, b.id))) continue;
			const d = overlap(a.files, b.files);
			if (d < bd) { bd = d; best = b; if (d === 0) break; }
		}
		if (best) return [a, best];
	}
	return null;
}

function pickFerge(w, busy) {
	const ok = (id) => { const b = w.bubbles.get(id); return b && idle(w, b) && !b.locked && !busy.has(id); };
	const cands = [...w.conflicts.values()].filter((c) => ok(c.a) && ok(c.b));
	const req = cands.find((c) => w.requested.has(pairKey(c.a, c.b)));
	if (req) return req;
	return w.opts.autoFerge ? cands[0] : null;
}

function startOp(w, kind, a, b) {
	a.visible = b.visible = false;
	a.hiddenBy = b.hiddenBy = kind;
	w.ops.push({ kind, a: a.id, b: b.id, until: w.t + (kind === "merge" ? 8 + w.rng() * 12 : 30 + w.rng() * 20) });
}

function finishOp(w, op) {
	const a = w.bubbles.get(op.a), b = w.bubbles.get(op.b);
	if (!a || !b) return;
	a.visible = b.visible = true;
	a.hiddenBy = b.hiddenBy = null;
	const c = contested(a, b);
	if (op.kind === "merge") {
		const p = a.fixed || b.fixed ? 0 : 1 - Math.pow(0.8, c.length);
		if (w.rng() < p) { w.conflicts.set(pairKey(a.id, b.id), { a: a.id, b: b.id, since: w.t }); w.stats.conflicts++; return; }
		const [keep, gone] = a.n <= b.n ? [a, b] : [b, a];
		absorb(w, keep, gone);
		w.stats.merges++;
		return;
	}
	// Ferge: the older bubble absorbs the other without the conflicting files; a locked ferge bubble holds them.
	w.conflicts.delete(pairKey(a.id, b.id));
	w.requested.delete(pairKey(a.id, b.id));
	const [keep, gone] = a.n <= b.n ? [a, b] : [b, a];
	const name = [keep.adj, gone.adj, `${keep.noun}${gone.noun}`, "ferge"].filter(Boolean).join(" ");
	absorb(w, keep, gone);
	w.stats.ferges++;
	if (!c.length) return;
	const f = newBubble(w, `r-${w.opts.repo}-f-${hex(w)}`, { adj: keep.adj, noun: `${keep.noun}${gone.noun}`, name, ferge: true, locked: true, parent: keep.id });
	f.files.set(keep.files);
	f.last.set(keep.last);
	for (const x of c) set(f.own, x);
	f.conflictFiles = c;
	if (w.opts.fergeAgents) {
		const ag = startAgent(w, { basis: f, role: "ferge", files: c.slice(0, 6), title: `Resolve conflict markers in ${name}` });
		f.fergeAgent = ag.id;
	}
}

function alarm(w) {
	// Apply queues: each bubble's Box runs git am on its queue, then pushes once.
	for (const b of w.bubbles.values()) {
		if (b.applying.length && b.boxUntil <= w.t) {
			for (const m of b.applying) {
				b.nMerged++; w.seq++; w.stats.applied++;
				if (m.role === "ferge" || m.role === "person-ferge") { b.locked = false; b.fixed = true; b.fergeAgent = null; b.personFix = 0; }
			}
			b.applying = [];
		}
		if (b.visible && b.queue.length && b.boxUntil <= w.t) {
			b.applying = b.queue.splice(0);
			b.boxUntil = w.t + 4 + 1.2 * b.applying.length;
		}
	}
	// Neighbour merges: one at a time (blingo today), or every disjoint pair (the what-if).
	const busy = new Set(w.ops.flatMap((o) => [o.a, o.b]));
	const limit = w.opts.parallel ? 12 : 1;
	while (w.ops.length < limit) {
		const p = pickMerge(w, busy);
		if (p) { startOp(w, "merge", p[0], p[1]); busy.add(p[0].id); busy.add(p[1].id); continue; }
		const c = pickFerge(w, busy);
		if (c) { const a = w.bubbles.get(c.a), b = w.bubbles.get(c.b); startOp(w, "ferge", a, b); busy.add(a.id); busy.add(b.id); continue; }
		break;
	}
}

// A person working "Needs you", one item at a time.
function personTurn(w) {
	const n = needs(w)[0];
	if (!n) return;
	if (n.kind === "conflict") w.requested.add(pairKey(n.a, n.b));
	else if (n.kind === "fork" || n.kind === "task") {
		const a = w.agents.get(n.id);
		if (!a) return;
		a.person = false; a.why = ""; a.pushes = 0; a.state = "running"; a.fixing = true; a.until = w.t + 300 + w.rng() * 600;
	} else if (n.kind === "ferge") {
		const b = w.bubbles.get(n.bubble);
		if (b) b.personFix = w.t + 600 + w.rng() * 600;
	}
}

function step(w, dt) {
	const end = w.t + dt;
	while (w.t < end) {
		const h = Math.min(5, end - w.t);
		w.t += h;
		// Superagents keep the queue full: start agents up to the target, ramping over the first minutes.
		let n = 0;
		for (const a of w.agents.values()) if (working(a) && a.role === "agent") n++;
		const room = Math.min(w.opts.agents - n, Math.ceil((w.opts.agents * h) / 240));
		for (let i = 0; i < room; i++) startAgent(w);
		for (const a of [...w.agents.values()]) if (!a.person && a.until <= w.t) advanceAgent(w, a);
		for (const op of [...w.ops]) if (op.until <= w.t) { w.ops.splice(w.ops.indexOf(op), 1); finishOp(w, op); }
		for (const b of w.bubbles.values())
			if (b.personFix && b.personFix <= w.t && b.locked) { b.personFix = 0; b.queue.push({ id: `${b.id}-fix`, role: "person-ferge" }); b.members++; }
		if (w.t >= w.nextAlarm) { alarm(w); w.nextAlarm = w.t + 5; }
		if (w.opts.person && w.t >= w.nextPerson) { personTurn(w); w.nextPerson = w.t + 120; }
		if (w.t >= w.nextSample) { sample(w); w.nextSample = w.t + 60; }
	}
	const cut = w.t - 3600;
	const pl = w.placeLog;
	let i = 0;
	while (i < pl.length && pl[i][0] < cut) i++;
	if (i) pl.splice(0, i);
}

function needs(w) {
	const out = [];
	const forks = [], tasks = [];
	for (const [k, c] of w.conflicts) out.push({ kind: "conflict", key: `c:${k}`, a: c.a, b: c.b, since: c.since });
	for (const a of w.agents.values()) {
		if (a.state === "person") forks.push({ kind: "fork", key: `f:${a.id}`, id: a.id, title: a.title, why: a.why, mark: "failed", since: a.since });
		else if (a.state === "failed") tasks.push({ kind: "task", key: `t:${a.id}`, id: a.id, title: a.title, why: a.why, mark: "failed", since: a.since });
	}
	out.push(...forks, ...tasks);
	for (const b of w.bubbles.values())
		if (b.ferge && b.locked && !b.fergeAgent && !b.personFix && !b.queue.length && !b.applying.length)
			out.push({ kind: "ferge", key: `g:${b.id}`, bubble: b.id, why: "Fix its conflicting files in a fork, then unlock it", since: b.created });
	// The app's order: conflicts, forks, tasks, then ferge bubbles.
	return out;
}

function census(w) {
	const c = { running: 0, ci: 0, placing: 0, person: 0, bubbles: w.bubbles.size, queued: 0, starving: 0, locked: 0, merging: w.ops.length };
	for (const a of w.agents.values()) {
		if (a.person) c.person++;
		else if (a.state === "running") c.running++;
		else if (a.state === "ci" || a.state === "review") c.ci++;
		else if (a.state === "placing") c.placing++;
	}
	for (const b of w.bubbles.values()) {
		c.queued += b.queue.length + b.applying.length;
		if (b.visible && !b.locked && !idle(w, b)) c.starving++;
		if (b.locked) c.locked++;
	}
	c.perHour = w.placeLog.length;
	return c;
}

function sample(w) {
	const c = census(w);
	w.history.push({ t: w.t, bubbles: c.bubbles, needs: needs(w).length, perHour: c.perHour });
	if (w.history.length > 720) w.history.shift();
}

const engine = { createWorld, step, needs, census, resolve, bitsOf, count, DEFAULTS, working };
if (typeof module !== "undefined") module.exports = engine;
