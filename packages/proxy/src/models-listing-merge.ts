import { listModelAliases } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";

const log = new Logger("ModelsListingMerge");

/**
 * A listing entry as clients expect to read it. Anthropic's own `/v1/models`
 * entries carry more (`created_at`, and whatever it adds later); this is only
 * the shape this module *writes*, never a constraint on what it passes through.
 */
export interface ModelsListingEntry {
	type: "model";
	id: string;
	display_name: string;
	description?: string;
}

/**
 * Upper bound on a listing body we are willing to buffer in order to merge.
 * A larger body is forwarded byte-for-byte, unmerged.
 *
 * 4 MB, and the number is measured rather than guessed. A Codex account's real
 * `/v1/models` answer on 2026-09-28 was 419 KB for **four** models: each entry
 * carries ~80 KB of per-model configuration, and the body repeats the whole
 * array under both `data` and `models`. A 256 KB bound — the figure this
 * started at, borrowed from the response tee — silently skipped the merge on
 * the very first real response it saw. The headroom is for an account that
 * lists twenty of those, not for comfort.
 *
 * Buffering this much is acceptable here and nowhere else: a client fetches its
 * model list at startup, not per message.
 */
export const MAX_MODELS_LISTING_MERGE_BYTES = 4 * 1024 * 1024;

/**
 * Entries to add to whatever the upstream answered.
 *
 * Registered aliases come first and last in importance: they are the reason
 * this merge exists. `catalogEntries` carries the Anthropic models the Claude
 * accounts serve, so that a client whose request happened to be answered by a
 * Codex account still sees the Claude models it can ask for — without it, the
 * listing a client caches would depend on which account won the load balancer,
 * which is nobody's intent.
 */
export interface ModelsListingExtras {
	catalogEntries?: ReadonlyArray<{
		id: string;
		displayName?: string;
		description?: string;
	}>;
}

/** Registered aliases rendered as listing entries. */
export function aliasListingEntries(): ModelsListingEntry[] {
	return Object.entries(listModelAliases()).map(([id, alias]) => ({
		type: "model" as const,
		id,
		display_name: alias.displayName ?? id,
		...(alias.description ? { description: alias.description } : {}),
	}));
}

/**
 * Merge extra entries into an upstream `/v1/models` body.
 *
 * Returns the new body, or null when the body is not a listing this code
 * understands — in which case the caller must forward the original untouched.
 * Null is the honest answer for "upstream said something unexpected"; inventing
 * a listing on top of an error payload would turn a visible upstream failure
 * into a plausible-looking success.
 *
 * Upstream always wins a collision, and always keeps its position: a client
 * reading this must see exactly what it would have seen without the feature,
 * plus entries at the end. That is the whole contract.
 */
export function mergeModelsListingBody(
	bodyText: string,
	extras: ModelsListingExtras = {},
): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		return null;

	const listing = parsed as Record<string, unknown>;
	if (!Array.isArray(listing.data)) return null;

	const seen = new Set<string>();
	for (const entry of listing.data) {
		if (entry && typeof entry === "object" && !Array.isArray(entry)) {
			const id = (entry as Record<string, unknown>).id;
			if (typeof id === "string") seen.add(id);
		}
	}

	const additions: ModelsListingEntry[] = [];
	const push = (entry: ModelsListingEntry): void => {
		if (seen.has(entry.id)) return;
		seen.add(entry.id);
		additions.push(entry);
	};

	for (const model of extras.catalogEntries ?? []) {
		if (!model.id) continue;
		push({
			type: "model",
			id: model.id,
			display_name: model.displayName || model.id,
			...(model.description ? { description: model.description } : {}),
		});
	}
	for (const entry of aliasListingEntries()) push(entry);

	if (additions.length === 0) return null;

	// A Codex listing repeats the same array under `models` alongside `data`
	// (measured 2026-09-28). Augmenting only `data` would leave the document
	// disagreeing with itself, so any consumer reading the other key would see
	// a listing without the additions — a bug that only shows up on whichever
	// key that consumer happened to pick.
	const mirrored = Array.isArray(listing.models)
		? { models: [...listing.models, ...additions] }
		: {};

	return JSON.stringify({
		...listing,
		data: [...listing.data, ...additions],
		...mirrored,
	});
}

/**
 * Stream wrapper around `mergeModelsListingBody`.
 *
 * Buffers up to `MAX_MODELS_LISTING_MERGE_BYTES` because JSON cannot be
 * rewritten before the whole document is in hand, then emits either the merged
 * body or — on overflow, a parse failure, or nothing to add — the original
 * bytes exactly as they arrived. There is no path on which this drops or
 * reorders an upstream entry.
 */
export function mergeModelsListingStream(
	upstream: ReadableStream<Uint8Array>,
	/**
	 * Loaded lazily and inside the stream, because the Anthropic catalog
	 * accessor is async while the call site that builds the client body is not.
	 * A loader that rejects degrades to aliases only rather than failing the
	 * response — the client still gets the upstream listing either way.
	 */
	loadExtras: () => Promise<ModelsListingExtras> = async () => ({}),
): ReadableStream<Uint8Array> {
	const reader = upstream.getReader();

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const chunks: Uint8Array[] = [];
			let total = 0;
			let overflowed = false;
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					if (!value || value.length === 0) continue;
					chunks.push(value);
					total += value.length;
					if (total > MAX_MODELS_LISTING_MERGE_BYTES) {
						overflowed = true;
						break;
					}
				}

				const emitOriginal = (): void => {
					for (const chunk of chunks) controller.enqueue(chunk);
				};

				if (overflowed) {
					log.warn(
						`/v1/models body over ${MAX_MODELS_LISTING_MERGE_BYTES} bytes — forwarding unmerged`,
					);
					emitOriginal();
					// Drain the rest so the client still gets the complete body.
					while (true) {
						const { value, done } = await reader.read();
						if (done) break;
						if (value) controller.enqueue(value);
					}
					controller.close();
					reader.releaseLock();
					return;
				}

				const joined = new Uint8Array(total);
				let offset = 0;
				for (const chunk of chunks) {
					joined.set(chunk, offset);
					offset += chunk.length;
				}

				let extras: ModelsListingExtras = {};
				try {
					extras = await loadExtras();
				} catch (error) {
					log.warn(
						`Could not load the Anthropic catalog for the /v1/models merge — continuing with aliases only: ${error instanceof Error ? error.message : String(error)}`,
					);
				}

				const merged = mergeModelsListingBody(
					new TextDecoder().decode(joined),
					extras,
				);
				if (merged === null) emitOriginal();
				else controller.enqueue(new TextEncoder().encode(merged));

				controller.close();
				reader.releaseLock();
			} catch (error) {
				controller.error(error);
				reader.releaseLock();
			}
		},
		cancel(reason) {
			return reader.cancel(reason).finally(() => reader.releaseLock());
		},
	});
}
