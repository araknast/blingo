// An in-app confirmation (Confirm.svelte, mounted once in App): `if (await ask({...})) …`.
export type Ask = { title: string; body: string; confirm: string; danger?: boolean };

export const asking = $state<{ q: Ask | null; answer: (yes: boolean) => void }>({ q: null, answer: () => {} });

export function ask(q: Ask): Promise<boolean> {
	asking.answer(false); // a question still open is declined
	return new Promise((resolve) => {
		asking.q = q;
		asking.answer = (yes) => {
			asking.q = null;
			asking.answer = () => {};
			resolve(yes);
		};
	});
}
