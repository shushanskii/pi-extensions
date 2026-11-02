/**
 * rewrite-compact — a compaction summary that is rewritten, not appended to.
 *
 * Pi's default summary prompt says "preserve all previous, add new", so every
 * compaction is longer than the one before: on the openwiki session of 2026-10-14
 * the first summary cost 5 103 output tokens, the second 11 978. The cap is
 * min(0.8 * reserveTokens, model.maxTokens), and the summary is generated at the
 * session's thinking level — qwen3.8-flash-next runs at xhigh, which spends up to
 * 8 192 of that cap thinking. The third summary hit the cap, pi discarded it as
 * incomplete, retried every turn, and the context walked up to the 210 000 window.
 *
 * Both causes are removed here:
 *   - thinking is off: no `reasoning` option means pi-ai sends the model's
 *     thinkingLevelMap.off ("none"), so the whole cap goes to the summary;
 *   - the previous summary is input, not a prefix: the model writes one
 *     self-contained summary under a fixed budget, dropping finished detail.
 *
 * Anything that goes wrong — no model, empty text, a length stop, an error —
 * returns undefined and pi runs its default compaction. Worst case is today.
 *
 * Kept from the default: firstKeptEntryId (the last keepRecentTokens stay verbatim),
 * the session model (already resident in llama-swap — no swap to summarize), and the
 * <read-files>/<modified-files> lists. Pi carries those lists forward only from its own
 * compactions (fromHook: false), so this one carries them from its own previous entry.
 */

import {
	type CompactionEntry,
	convertToLlm,
	type ExtensionAPI,
	type SessionBeforeCompactEvent,
	type SessionEntry,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";

// The target the prompt names, and the hard cap. The gap is headroom: a model that
// overshoots a word budget by half still finishes instead of stopping on length.
const TARGET_WORDS = 2500;
const MAX_TOKENS = 12_288;

// The shape this package writes into its own compaction entry's `details`.
interface CarriedDetails {
	readFiles?: string[];
	modifiedFiles?: string[];
}

// pi types `details` as unknown because each extension defines its own; reading this package's
// shape back is therefore a cast — the one narrowing here, and one field rather than a value.
function lastCompaction(entries: readonly SessionEntry[]): CompactionEntry<CarriedDetails> | undefined {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry?.type === "compaction") {
			return entry as CompactionEntry<CarriedDetails>;
		}
	}
	return undefined;
}

// The one-line shape of a thrown value, for a notice.
function messageOf(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function carriedFileLists(event: SessionBeforeCompactEvent) {
	const read = new Set(event.preparation.fileOps.read);
	const modified = new Set([...event.preparation.fileOps.edited, ...event.preparation.fileOps.written]);
	const last = lastCompaction(event.branchEntries);
	if (last?.fromHook && last.details) {
		for (const f of last.details.readFiles ?? []) {
			read.add(f);
		}
		for (const f of last.details.modifiedFiles ?? []) {
			modified.add(f);
		}
	}
	const readFiles = [...read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	const blocks: string[] = [];
	if (readFiles.length > 0) {
		blocks.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		blocks.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	let text = "";
	if (blocks.length > 0) {
		text = `\n\n${blocks.join("\n\n")}`;
	}
	return { readFiles, modifiedFiles, text };
}

// The summary prompt. The two blocks about a previous summary are built first so the
// template below is one sentence rather than three conditionals.
function promptFor(previous: string, conversation: string): string {
	let mergeNote = "";
	let previousBlock = "";
	if (previous) {
		mergeNote =
			"The previous summary is given below as INPUT: merge it with the new conversation and rewrite the whole thing. Do not copy it forward — compress finished work to one line each, drop detail that no longer matters for continuing.";
		previousBlock = `\n<previous_summary>\n${previous}\n</previous_summary>\n`;
	}
	return `You are compacting the history of a coding-agent session. Your output REPLACES the earlier history; the most recent turns are kept verbatim after it, so do not restate them in detail.

Write ONE self-contained summary of at most ${TARGET_WORDS} words. ${mergeNote}

Sections, in this order:
## Goal — what the user asked for, in their terms, and any constraints they set.
## Done — finished work, one line per item, with file paths.
## In progress — exactly where the work stands now and the next concrete step.
## Decisions — choices made and why, only those that still constrain the work.
## Facts — exact paths, identifiers, commands, numbers, error messages needed to continue.
## Open — unresolved questions and blockers.

Prefer exact paths and names over prose. No preamble, no closing remarks.
${previousBlock}
<conversation>
${conversation}
</conversation>`;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, previousSummary, firstKeptEntryId, tokensBefore } = preparation;

		const { model } = ctx;
		if (!model) {
			return;
		}

		const conversation = serializeConversation(convertToLlm([...messagesToSummarize, ...turnPrefixMessages]));
		let budget = MAX_TOKENS;
		if (model.maxTokens > 0) {
			budget = model.maxTokens;
		}
		const maxTokens = Math.min(MAX_TOKENS, budget);

		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: promptFor(previousSummary ?? "", conversation) }],
							timestamp: Date.now(),
						},
					],
				},
				{ maxTokens, signal, cacheRetention: "none" },
			);

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map(({ text }) => text)
				.join("\n")
				.trim();

			if (response.stopReason === "length") {
				ctx.ui.notify(`rewrite-compact: summary hit ${maxTokens} tokens, using default compaction`, "warning");
				return;
			}
			if (!summary) {
				if (!signal.aborted) {
					ctx.ui.notify("rewrite-compact: empty summary, using default compaction", "warning");
				}
				return;
			}

			const files = carriedFileLists(event);
			ctx.ui.notify(
				`rewrite-compact: ${tokensBefore.toLocaleString()} tokens → summary of ${response.usage.output.toLocaleString()}`,
				"info",
			);
			return {
				compaction: {
					summary: summary + files.text,
					firstKeptEntryId,
					tokensBefore,
					usage: response.usage,
					details: { readFiles: files.readFiles, modifiedFiles: files.modifiedFiles },
				},
			};
		} catch (error) {
			if (signal.aborted) {
				return;
			}
			const message = messageOf(error);
			ctx.ui.notify(`rewrite-compact: ${message}, using default compaction`, "error");
		}
	});
}
