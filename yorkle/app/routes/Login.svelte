<script lang="ts">
	import AuthFrame from "../lib/AuthFrame.svelte";
	import { api, loadMe, session, setToken } from "../lib/session.svelte";

	let username = $state("");
	let password = $state("");
	let token = $state("");
	let useToken = $state(false);
	let error = $state("");
	let busy = $state(false);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = "";
		try {
			if (useToken) setToken(token.trim());
			else setToken((await api<{ token: string }>("POST", "/login", { username, password })).token);
			await loadMe();
			if (useToken && !session.me) {
				setToken("");
				error = "That token wasn't accepted. Check it and try again.";
			}
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = false;
		}
	}
</script>

<AuthFrame title="Log in">
	<form onsubmit={submit}>
		{#if useToken}
			<div class="field">
				<label for="token">API token</label>
				<input id="token" type="password" autocomplete="off" bind:value={token} required />
				<p class="hint">The deployment's BLINGO_TOKEN signs you in as the admin.</p>
			</div>
		{:else}
			<div class="field">
				<label for="user">Username</label>
				<input id="user" autocomplete="username" bind:value={username} required />
			</div>
			<div class="field">
				<label for="pass">Password</label>
				<input id="pass" type="password" autocomplete="current-password" bind:value={password} required />
			</div>
		{/if}
		{#if error}<p class="error" role="alert">{error}</p>{/if}
		<div class="row">
			<button class="primary" disabled={busy}>Log in</button>
			<button type="button" class="quiet" onclick={() => ((useToken = !useToken), (error = ""))}>
				{useToken ? "Use a password instead" : "Use an API token instead"}
			</button>
		</div>
	</form>
	{#snippet footer()}New here? <a href="/signup">Sign up with an invite code</a>{/snippet}
</AuthFrame>

<style>
	.row { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.5rem; }
	.error { color: var(--conflict); font-size: 0.875rem; margin-bottom: 0.75rem; }
</style>
