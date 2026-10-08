<script lang="ts">
	import AuthFrame from "../lib/AuthFrame.svelte";
	import { api } from "../lib/session.svelte";

	let invite = $state(new URLSearchParams(location.search).get("invite") ?? "");
	let username = $state("");
	let email = $state("");
	let password = $state("");
	let error = $state("");
	let busy = $state(false);
	let sentTo = $state("");

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = "";
		try {
			await api("POST", "/signup", { invite: invite.trim(), username, email, password });
			sentTo = email;
			password = "";
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = false;
		}
	}
</script>

<AuthFrame title={sentTo ? "Check your email" : "Sign up"}>
	{#if sentTo}
		<p>We sent a link to <strong>{sentTo}</strong>. Open it within 24 hours to create your account, then log in.</p>
		<p class="again"><a class="button primary" href="/login">Go to log in</a></p>
	{:else}
		<form onsubmit={submit}>
			<div class="field">
				<label for="invite">Invite code</label>
				<input id="invite" autocomplete="off" bind:value={invite} required />
			</div>
			<div class="field">
				<label for="user">Username</label>
				<input id="user" autocomplete="username" pattern={"[a-z0-9_\\-]{2,32}"} bind:value={username} required />
				<p class="hint">2 to 32 lowercase letters, digits, - or _.</p>
			</div>
			<div class="field">
				<label for="email">Email</label>
				<input id="email" type="email" autocomplete="email" bind:value={email} required />
			</div>
			<div class="field">
				<label for="pass">Password</label>
				<input id="pass" type="password" autocomplete="new-password" minlength="8" bind:value={password} required />
				<p class="hint">At least 8 characters.</p>
			</div>
			{#if error}<p class="error" role="alert">{error}</p>{/if}
			<button class="primary" disabled={busy}>Sign up</button>
		</form>
	{/if}
	{#snippet footer()}Already have an account? <a href="/login">Log in</a>{/snippet}
</AuthFrame>

<style>
	.error { color: var(--conflict); font-size: 0.875rem; margin-bottom: 0.75rem; }
	.again { margin-top: 1.25rem; }
</style>
