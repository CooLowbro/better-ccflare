import type { CustomModelAliases } from "@better-ccflare/core";
import { api } from "../api";

/**
 * Adapter for ONE pair of endpoints: the custom model alias map, which lets a
 * client ask for `claude-gpt-5.6-terra` and have `gpt-5.6-terra` sent to a
 * `codex` account. It exists because a Claude Code client's model picker never
 * sees an id failing `/(claude|anthropic)/i` — so without an alias there is no
 * way to select a non-Claude model from that picker at all.
 *
 * Everything the dashboard knows about these response shapes lives here: if
 * the backend changes the contract, this is the only file to update.
 *
 *   GET  /api/config/custom-model-aliases
 *     -> { aliases: { "<alias id>": { provider, model, displayName?, description? } } }
 *   POST /api/config/custom-model-aliases   body { aliases: {...} }
 *     -> replaces the WHOLE map. Not a merge: a merge offers no way to delete
 *        an alias, and an alias that cannot be deleted keeps sending traffic to
 *        a provider the operator has stopped choosing.
 *
 * Authentication comes for free from the shared `api` client, which injects
 * `x-api-key` into every request and opens the auth dialog on 401.
 */

/** One row as the screen edits it: the id travels alongside its value. */
export interface CustomModelAliasRow {
	id: string;
	provider: string;
	model: string;
	displayName: string;
	description: string;
}

function asRecord(raw: unknown): Record<string, unknown> {
	return raw && typeof raw === "object" && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: {};
}

function asString(raw: unknown): string {
	return typeof raw === "string" ? raw.trim() : "";
}

/**
 * The alias map as rows, sorted by id.
 *
 * An entry missing `provider` or `model` is dropped rather than shown half
 * empty: it cannot route, so displaying it as if it could would be worse than
 * admitting it is not there. Malformed input becomes an empty list.
 */
export async function fetchCustomModelAliases(): Promise<
	CustomModelAliasRow[]
> {
	const body = asRecord(await api.get<unknown>("/api/config/custom-model-aliases"));
	const aliases = asRecord(body.aliases);
	const rows: CustomModelAliasRow[] = [];
	for (const [id, raw] of Object.entries(aliases)) {
		const entry = asRecord(raw);
		const provider = asString(entry.provider);
		const model = asString(entry.model);
		if (!id.trim() || !provider || !model) continue;
		rows.push({
			id: id.trim(),
			provider,
			model,
			displayName: asString(entry.displayName),
			description: asString(entry.description),
		});
	}
	return rows.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Saves the whole map in one operation, triggered by the Save button: this
 * screen does not save on every keystroke.
 *
 * Optional fields are omitted when blank rather than sent as empty strings, so
 * that a cleared Display Name goes back to falling through to the alias id
 * instead of becoming an empty label in someone's model picker.
 */
export async function saveCustomModelAliases(
	rows: CustomModelAliasRow[],
): Promise<void> {
	const aliases: CustomModelAliases = {};
	for (const row of rows) {
		const id = row.id.trim();
		if (!id) continue;
		aliases[id] = {
			provider: row.provider.trim(),
			model: row.model.trim(),
			...(row.displayName.trim()
				? { displayName: row.displayName.trim() }
				: {}),
			...(row.description.trim()
				? { description: row.description.trim() }
				: {}),
		};
	}
	await api.post("/api/config/custom-model-aliases", { aliases });
}
