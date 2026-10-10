// 3725000 → "1h 2m", 90061000 → "1d 1h": the two largest units (s, m, h, d, w, mo = 30 d, y = 365 d).
export function elapsed(ms: number) {
	let s = Math.max(0, Math.floor(ms / 1000));
	const parts: string[] = [];
	for (const [unit, n] of [["y", 365 * 86400], ["mo", 30 * 86400], ["w", 7 * 86400], ["d", 86400], ["h", 3600], ["m", 60], ["s", 1]] as const) {
		const q = Math.floor(s / n);
		s -= q * n;
		if (q || parts.length) parts.push(`${q}${unit}`);
		if (parts.length === 2) break;
	}
	return parts.join(" ") || "0s";
}
