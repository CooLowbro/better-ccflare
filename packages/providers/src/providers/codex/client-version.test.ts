import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	CODEX_VERSION_FLOOR,
	getCodexUserAgent,
	getCodexVersion,
	refreshCodexVersion,
	setDiscoveredCodexVersionForTests,
} from "./client-version";

/**
 * The version this gateway declares to OpenAI.
 *
 * Measured on 2026-10-06 against a live account: the catalogue and the
 * execution endpoint are both served according to the declared version. At
 * 0.158.0 `gpt-6.1-sol` is absent from the listing and answers HTTP 400; at
 * 0.159.0 it is listed and the same request completes. A constant edited by
 * hand therefore ages into a smaller product, which is what this module exists
 * to prevent — and why its failure modes matter more than its happy path.
 */

function releaseResponse(tag: unknown, status = 200): Response {
	return new Response(JSON.stringify({ tag_name: tag }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

let originalFetch: typeof globalThis.fetch;
let requestedUrl: string | null;

beforeEach(() => {
	originalFetch = globalThis.fetch;
	requestedUrl = null;
	setDiscoveredCodexVersionForTests(null);
	delete process.env.CCFLARE_CODEX_CLIENT_VERSION;
	delete process.env.CCFLARE_CODEX_VERSION_DISCOVERY;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	setDiscoveredCodexVersionForTests(null);
	delete process.env.CCFLARE_CODEX_CLIENT_VERSION;
	delete process.env.CCFLARE_CODEX_VERSION_DISCOVERY;
});

function stubReleases(response: Response | (() => never)) {
	globalThis.fetch = (async (url: string | URL) => {
		requestedUrl = String(url);
		if (typeof response === "function") response();
		return response;
	}) as unknown as typeof globalThis.fetch;
}

describe("the declared Codex client version", () => {
	it("falls back to the compiled floor before anything has been read", () => {
		expect(getCodexVersion()).toBe(CODEX_VERSION_FLOOR);
		expect(getCodexUserAgent()).toContain(`codex-cli/${CODEX_VERSION_FLOOR}`);
	});

	it("adopts a newer version from the Codex CLI's own releases", async () => {
		stubReleases(releaseResponse("rust-v0.199.0"));

		await expect(refreshCodexVersion()).resolves.toBe("0.199.0");

		expect(requestedUrl).toBe(
			"https://api.github.com/repos/openai/codex/releases/latest",
		);
		expect(getCodexVersion()).toBe("0.199.0");
		expect(getCodexUserAgent()).toContain("codex-cli/0.199.0");
	});

	// Only ever forward: a rolled-back release feed, or a repository that starts
	// publishing something else under the same tag, must not talk this gateway
	// down to a version already measured as too old to see current models.
	it("never moves backwards", async () => {
		setDiscoveredCodexVersionForTests("0.199.0");
		stubReleases(releaseResponse("rust-v0.160.1"));

		await expect(refreshCodexVersion()).resolves.toBeNull();

		expect(getCodexVersion()).toBe("0.199.0");
	});

	it("ignores a tag that is not a Codex CLI release", async () => {
		stubReleases(releaseResponse("v2-experimental"));

		await expect(refreshCodexVersion()).resolves.toBeNull();

		expect(getCodexVersion()).toBe(CODEX_VERSION_FLOOR);
	});

	// A version feed being unreachable is not a reason to stop serving traffic:
	// the previous answer still works.
	it("keeps the last answer when the releases feed cannot be read", async () => {
		setDiscoveredCodexVersionForTests("0.199.0");
		stubReleases(() => {
			throw new Error("network down");
		});

		await expect(refreshCodexVersion()).resolves.toBeNull();

		expect(getCodexVersion()).toBe("0.199.0");
	});

	it("keeps the last answer on an HTTP error, including a rate limit", async () => {
		setDiscoveredCodexVersionForTests("0.199.0");
		stubReleases(releaseResponse("rust-v0.300.0", 403));

		await expect(refreshCodexVersion()).resolves.toBeNull();

		expect(getCodexVersion()).toBe("0.199.0");
	});

	// Declaring a version is a claim about request and response shape, not just
	// a number, so an operator needs a way back that does not need a rebuild.
	it("lets an operator pin a version, and stops asking once pinned", async () => {
		process.env.CCFLARE_CODEX_CLIENT_VERSION = "0.158.0";
		stubReleases(releaseResponse("rust-v0.199.0"));

		await expect(refreshCodexVersion()).resolves.toBeNull();

		expect(requestedUrl).toBeNull();
		expect(getCodexVersion()).toBe("0.158.0");
	});

	it("ignores a pin that is not a version", () => {
		process.env.CCFLARE_CODEX_CLIENT_VERSION = "latest";

		expect(getCodexVersion()).toBe(CODEX_VERSION_FLOOR);
	});

	it("can have discovery turned off entirely", async () => {
		process.env.CCFLARE_CODEX_VERSION_DISCOVERY = "off";
		stubReleases(releaseResponse("rust-v0.199.0"));

		await expect(refreshCodexVersion()).resolves.toBeNull();

		expect(requestedUrl).toBeNull();
		expect(getCodexVersion()).toBe(CODEX_VERSION_FLOOR);
	});
});
