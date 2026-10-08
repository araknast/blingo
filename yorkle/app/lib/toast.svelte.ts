export type Toast = { id: number; text: string; error: boolean };

export const toasts = $state<Toast[]>([]);
let next = 0;

export function toast(text: string, error = false) {
	const id = next++;
	toasts.push({ id, text, error });
	setTimeout(() => dismiss(id), error ? 8000 : 4000);
}

export const toastError = (e: unknown) => toast(e instanceof Error ? e.message : String(e), true);

export function dismiss(id: number) {
	const i = toasts.findIndex((t) => t.id === id);
	if (i >= 0) toasts.splice(i, 1);
}
