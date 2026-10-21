import { Logger } from "@better-ccflare/logger";

const log = new Logger("CodexClientVersion");

/**
 * The Codex CLI version this gateway claims to be.
 *
 * It is not cosmetic. OpenAI serves both the model catalogue and the execution
 * endpoint *according to the version the caller declares* — `client_version` on
 * `/backend-api/codex/models`, the `Version` header on
 * `/backend-api/codex/responses`. Measured on 2026-10-06 against a live
 * account:
 *
 *   0.157.1 -> catalogue of 10 models, and `gpt-6.1-sol` answers HTTP 400
 *              "not supported when using Codex with a ChatGPT account"
 *   0.158.0 -> same
 *   0.159.0 -> catalogue of 11 models, and the same request completes
 *   0.160.1 -> same, and this is what openai/codex had published
 *
 * So a pinned version silently ages into a smaller product: models ship, the
 * declared client never hears about them, and the refusal arrives wearing the
 * costume of a plan limit. Hence this module — the version follows the Codex
 * CLI's own releases instead of a constant someone has to remember to edit.
 */

/**
 * What is declared before any release has been read, and the floor no
 * discovery may go below.
 *
 * Bump it when a measurement proves a newer version is needed and the network
 * cannot be relied on to say so — otherwise leave it alone and let discovery
 * do its job.
 */
export const CODEX_VERSION_FLOOR = "0.160.1";

/**
 * The Codex CLI's own releases. The project publishes its Rust binary under a
 * `rust-v<semver>` tag, which is the version string the API expects.
 *
 * Deliberately the source repository and not the npm package: the repo is
 * where the release is cut, npm is a mirror of it, and a question about "what
 * version of Codex exists" is best asked where the answer is produced.
 */
const RELEASES_URL =
	"https://api.github.com/repos/openai/codex/releases/latest";
const TAG_PATTERN = /^rust-v(\d+\.\d+\.\d+)$/;
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1_000;
const FETCH_TIMEOUT_MS = 15_000;

/** Last version read from the releases feed, or null before the first read. */
let discovered: string | null = null;

/**
 * An operator's explicit choice, which beats everything else.
 *
 * Exists because declaring a version is a claim about request and response
 * shape, not just a number: if a future release changes what the endpoint
 * expects, pinning is the way back without rebuilding an image.
 */
function pinnedVersion(): string | null {
	const raw = process.env.CCFLARE_CODEX_CLIENT_VERSION?.trim();
	if (!raw) return null;
	if (!SEMVER_PATTERN.test(raw)) {
		log.warn(
			`CCFLARE_CODEX_CLIENT_VERSION="${raw}" is not a version like 0.160.1 — ignoring it`,
		);
		return null;
	}
	return raw;
}

/** The version to declare right now. Never throws, never blocks. */
export function getCodexVersion(): string {
	return pinnedVersion() ?? discovered ?? CODEX_VERSION_FLOOR;
}

/** The User-Agent that goes with it. */
export function getCodexUserAgent(): string {
	return `codex-cli/${getCodexVersion()} (Windows 10.0.26100; x64)`;
}

function parseSemver(version: string): [number, number, number] | null {
	const match = SEMVER_PATTERN.exec(version);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Whether `candidate` is strictly newer than `current`.
 *
 * Only ever moves forward: a malformed tag, a repository that starts
 * publishing something else under the same name, or a release feed rolled back
 * must not talk this gateway down to a version already measured as too old.
 */
function isNewer(candidate: string, current: string): boolean {
	const a = parseSemver(candidate);
	const b = parseSemver(current);
	if (!a || !b) return false;
	for (let index = 0; index < 3; index++) {
		if (a[index] !== b[index]) return a[index] > b[index];
	}
	return false;
}

/**
 * Read the Codex CLI's latest release and adopt its version if it is newer.
 *
 * Returns the version adopted, or null when nothing changed — including every
 * failure. Failing to reach GitHub is not an error worth propagating: the
 * previous answer is still a working one, and a gateway that refuses traffic
 * because a version feed is down would be a worse bug than the one this
 * module exists to fix.
 */
export async function refreshCodexVersion(): Promise<string | null> {
	if (process.env.CCFLARE_CODEX_VERSION_DISCOVERY === "off") return null;
	// An operator who pinned a version has already answered the question;
	// spending a request to be overruled would be noise.
	if (pinnedVersion()) return null;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(RELEASES_URL, {
			headers: {
				accept: "application/vnd.github+json",
				// GitHub answers 403 to a request without one.
				"user-agent": "better-ccflare",
			},
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);

		const body = (await response.json()) as { tag_name?: unknown };
		const tag = typeof body.tag_name === "string" ? body.tag_name.trim() : "";
		const match = TAG_PATTERN.exec(tag);
		if (!match) {
			throw new Error(`"${tag}" is not a Codex CLI release tag`);
		}

		const candidate = match[1];
		const current = getCodexVersion();
		if (!isNewer(candidate, current)) return null;

		discovered = candidate;
		log.info(
			`Now declaring Codex client version ${candidate}, the latest openai/codex release (was ${current})`,
		);
		return candidate;
	} catch (error) {
		log.warn(
			`Could not read the current Codex CLI version from openai/codex (${error}); still declaring ${getCodexVersion()}`,
		);
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Start following the Codex CLI's releases: once now, then twice a day.
 *
 * Twice a day because the cost of being a day late is one model nobody can
 * reach yet, while the cost of asking often is a shared, unauthenticated rate
 * limit — 60 requests an hour for the whole host.
 */
export function initCodexVersionDiscovery(): () => void {
	void refreshCodexVersion();
	const timer = setInterval(() => {
		void refreshCodexVersion();
	}, REFRESH_INTERVAL_MS);
	// Nothing here is worth keeping the process alive for.
	timer.unref?.();
	return () => clearInterval(timer);
}

/** Test seam: the discovered version is process-wide and leaks between cases. */
export function setDiscoveredCodexVersionForTests(
	version: string | null,
): void {
	discovered = version;
}
