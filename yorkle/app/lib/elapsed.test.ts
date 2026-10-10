import { expect, test } from "vitest";
import { elapsed } from "./elapsed";

test("elapsed shows the two largest units up to years", () => {
	const s = 1000;
	expect(elapsed(4 * s)).toBe("4s");
	expect(elapsed(192 * s)).toBe("3m 12s");
	expect(elapsed(3600 * s)).toBe("1h 0m");
	expect(elapsed((5 * 3600 + 3 * 60 + 9) * s)).toBe("5h 3m");
	expect(elapsed((2 * 86400 + 4 * 3600) * s)).toBe("2d 4h");
	expect(elapsed(23 * 86400 * s)).toBe("3w 2d");
	expect(elapsed(67 * 86400 * s)).toBe("2mo 1w");
	expect(elapsed(430 * 86400 * s)).toBe("1y 2mo");
	expect(elapsed(-5)).toBe("0s");
});
