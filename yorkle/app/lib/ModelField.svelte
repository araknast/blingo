<script lang="ts">
	// A model for one run; empty = the repository's setting for that role.
	let { id, value = $bindable("") }: { id: string; value: string } = $props();
</script>

<label for={id}>Model</label>
<input {id} bind:value list="{id}-models" pattern={"[\\w./:-]{0,100}"} placeholder="The repository's default" autocomplete="off" />
<datalist id="{id}-models">
	<option value="claude-opus-5-5"></option>
	<option value="claude-sonnet-5-5"></option>
	<option value="claude-haiku-5-5"></option>
</datalist>
<p class="hint">Blank uses the model set in this repository's settings.</p>
