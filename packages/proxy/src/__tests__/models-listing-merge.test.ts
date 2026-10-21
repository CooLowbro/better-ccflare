import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { setCustomModelAliases } from "@better-ccflare/core";
import {
	MAX_MODELS_LISTING_MERGE_BYTES,
	mergeModelsListingBody,
	mergeModelsListingStream,
} from "../models-listing-merge";

const ALIASES = {
	"claude-gpt-5.6-sol": {
		provider: "codex",
		model: "gpt-5.6-sol",
		displayName: "Sol xhigh",
		description: "Codex via alias",
	},
};

function upstreamStream(text: string): ReadableStream<Uint8Array> {
	return new Response(text).body as ReadableStream<Uint8Array>;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
	return await new Response(stream).text();
}

beforeEach(() => {
	setCustomModelAliases({});
});

// The registry is process-global by design (see model-aliases.ts). Leaving it
// populated would reach every test file that runs after this one in the same
// bun process — which is exactly how this cleanup came to be written.
afterAll(() => {
	setCustomModelAliases({});
});

describe("mergeModelsListingBody", () => {
	test("keeps every upstream entry, in order, and appends the alias", () => {
		setCustomModelAliases(ALIASES);
		const upstream = {
			data: [
				{ type: "model", id: "claude-opus-5", display_name: "Opus 5" },
				{ type: "model", id: "claude-sonnet-5", display_name: "Sonnet 5" },
			],
			has_more: false,
			first_id: "claude-opus-5",
		};

		const merged = mergeModelsListingBody(JSON.stringify(upstream));
		expect(merged).not.toBeNull();
		const parsed = JSON.parse(merged as string);

		// The contract: a superset, upstream first and untouched.
		expect(parsed.data.slice(0, 2)).toEqual(upstream.data);
		expect(parsed.has_more).toBe(false);
		expect(parsed.first_id).toBe("claude-opus-5");
		expect(parsed.data).toHaveLength(3);
		expect(parsed.data[2]).toEqual({
			type: "model",
			id: "claude-gpt-5.6-sol",
			display_name: "Sol xhigh",
			description: "Codex via alias",
		});
	});

	test("upstream wins a collision — an alias never displaces a real entry", () => {
		setCustomModelAliases({
			"claude-sonnet-5": {
				provider: "codex",
				model: "gpt-5.6-sol",
				displayName: "Impostor",
			},
		});
		const upstream = {
			data: [{ type: "model", id: "claude-sonnet-5", display_name: "Sonnet 5" }],
		};

		expect(mergeModelsListingBody(JSON.stringify(upstream))).toBeNull();
	});

	test("adds the Anthropic catalog so the answering account cannot narrow the list", () => {
		setCustomModelAliases({});
		const merged = mergeModelsListingBody(
			JSON.stringify({ data: [{ type: "model", id: "gpt-5.6-sol" }] }),
			{
				catalogEntries: [{ id: "claude-opus-5", displayName: "Opus 5" }],
			},
		);
		const parsed = JSON.parse(merged as string);
		expect(parsed.data.map((m: { id: string }) => m.id)).toEqual([
			"gpt-5.6-sol",
			"claude-opus-5",
		]);
	});

	test("mirrors additions into a Codex listing's duplicate `models` key", () => {
		// Measured against a real Codex answer: it carries the same array twice.
		setCustomModelAliases(ALIASES);
		const merged = mergeModelsListingBody(
			JSON.stringify({
				object: "list",
				data: [{ id: "gpt-5.6-terra" }],
				models: [{ id: "gpt-5.6-terra" }],
			}),
		);
		const parsed = JSON.parse(merged as string);
		expect(parsed.data.map((m: { id: string }) => m.id)).toEqual(
			parsed.models.map((m: { id: string }) => m.id),
		);
		expect(parsed.models.map((m: { id: string }) => m.id)).toContain(
			"claude-gpt-5.6-sol",
		);
	});

	test("leaves a listing without a `models` key alone", () => {
		setCustomModelAliases(ALIASES);
		const merged = mergeModelsListingBody(
			JSON.stringify({ data: [{ id: "claude-opus-5" }] }),
		);
		expect(JSON.parse(merged as string).models).toBeUndefined();
	});

	test("returns null when there is nothing to add", () => {
		expect(mergeModelsListingBody(JSON.stringify({ data: [] }))).toBeNull();
	});

	test("returns null for a body that is not a listing", () => {
		setCustomModelAliases(ALIASES);
		expect(mergeModelsListingBody("not json")).toBeNull();
		expect(mergeModelsListingBody(JSON.stringify({ error: "nope" }))).toBeNull();
		expect(mergeModelsListingBody(JSON.stringify([1, 2]))).toBeNull();
	});

	test("survives the (claude|anthropic) filter a Claude Code client applies", () => {
		// Not a test of our code so much as of the naming rule it exists to
		// satisfy: the client drops every id failing this regex before its model
		// picker sees it, so an alias that does not match is invisible no matter
		// how correctly we serve it.
		setCustomModelAliases(ALIASES);
		const merged = mergeModelsListingBody(JSON.stringify({ data: [] }), {
			catalogEntries: [{ id: "claude-opus-5" }],
		});
		const parsed = JSON.parse(merged as string);
		const survivors = parsed.data.filter((m: { id: string }) =>
			/(claude|anthropic)/i.test(m.id),
		);
		expect(survivors.map((m: { id: string }) => m.id)).toContain(
			"claude-gpt-5.6-sol",
		);
	});
});

describe("mergeModelsListingStream", () => {
	test("emits the merged body", async () => {
		setCustomModelAliases(ALIASES);
		const out = await readAll(
			mergeModelsListingStream(
				upstreamStream(JSON.stringify({ data: [{ id: "claude-opus-5" }] })),
			),
		);
		const parsed = JSON.parse(out);
		expect(parsed.data.map((m: { id: string }) => m.id)).toEqual([
			"claude-opus-5",
			"claude-gpt-5.6-sol",
		]);
	});

	test("forwards an unparseable body byte-for-byte", async () => {
		setCustomModelAliases(ALIASES);
		const body = '{"error":{"message":"upstream said no"}}';
		expect(await readAll(mergeModelsListingStream(upstreamStream(body)))).toBe(
			body,
		);
	});

	test("forwards an oversized body unmerged rather than truncating it", async () => {
		setCustomModelAliases(ALIASES);
		const filler = "x".repeat(MAX_MODELS_LISTING_MERGE_BYTES + 1024);
		const body = JSON.stringify({ data: [{ id: "claude-opus-5" }], filler });
		expect(await readAll(mergeModelsListingStream(upstreamStream(body)))).toBe(
			body,
		);
	});

	test("a failing extras loader degrades to aliases only", async () => {
		setCustomModelAliases(ALIASES);
		const out = await readAll(
			mergeModelsListingStream(
				upstreamStream(JSON.stringify({ data: [{ id: "claude-opus-5" }] })),
				async () => {
					throw new Error("catalog unavailable");
				},
			),
		);
		const parsed = JSON.parse(out);
		expect(parsed.data.map((m: { id: string }) => m.id)).toEqual([
			"claude-opus-5",
			"claude-gpt-5.6-sol",
		]);
	});
});
