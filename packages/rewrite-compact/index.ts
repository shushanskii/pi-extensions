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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

// The target the prompt names, and the hard cap. The gap is headroom: a model that
// overshoots a word budget by half still finishes instead of stopping on length.
const TARGET_WORDS = 2500;
const MAX_TOKENS = 12288;

function carriedFileLists(event: {
	preparation: { fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> } };
	branchEntries: unknown[];
}) {
	const read = new Set(event.preparation.fileOps.read);
	const modified = new Set([...event.preparation.fileOps.edited, ...event.preparation.fileOps.written]);
	const last = [...event.branchEntries].reverse().find((e: any) => e?.type === "compaction") as any;
	if (last?.fromHook && last.details) {
		for (const f of last.details.readFiles ?? []) read.add(f);
		for (const f of last.details.modifiedFiles ?? []) modified.add(f);
	}
	const readFiles = [...read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	const blocks = [];
	if (readFiles.length) blocks.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	if (modifiedFiles.length) blocks.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	return { readFiles, modifiedFiles, text: blocks.length ? `\n\n${blocks.join("\n\n")}` : "" };
}

const PROMPT = (
	previous: string,
	conversation: string,
) => `You are compacting the history of a coding-agent session. Your output REPLACES the earlier history; the most recent turns are kept verbatim after it, so do not restate them in detail.

Write ONE self-contained summary of at most ${TARGET_WORDS} words. ${previous ? "The previous summary is given below as INPUT: merge it with the new conversation and rewrite the whole thing. Do not copy it forward — compress finished work to one line each, drop detail that no longer matters for continuing." : ""}

Sections, in this order:
## Goal — what the user asked for, in their terms, and any constraints they set.
## Done — finished work, one line per item, with file paths.
## In progress — exactly where the work stands now and the next concrete step.
## Decisions — choices made and why, only those that still constrain the work.
## Facts — exact paths, identifiers, commands, numbers, error messages needed to continue.
## Open — unresolved questions and blockers.

Prefer exact paths and names over prose. No preamble, no closing remarks.
${previous ? `\n<previous_summary>\n${previous}\n</previous_summary>\n` : ""}
<conversation>
${conversation}
</conversation>`;

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, previousSummary, firstKeptEntryId, tokensBefore } = preparation;

		const model = ctx.model;
		if (!model) return;

		const conversation = serializeConversation(convertToLlm([...messagesToSummarize, ...turnPrefixMessages]));
		const maxTokens = Math.min(MAX_TOKENS, model.maxTokens > 0 ? model.maxTokens : MAX_TOKENS);

		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: PROMPT(previousSummary ?? "", conversation) }],
							timestamp: Date.now(),
						},
					],
				},
				{ maxTokens, signal, cacheRetention: "none" },
			);

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.trim();

			if (response.stopReason === "length") {
				ctx.ui.notify(`rewrite-compact: summary hit ${maxTokens} tokens, using default compaction`, "warning");
				return;
			}
			if (!summary) {
				if (!signal.aborted) ctx.ui.notify("rewrite-compact: empty summary, using default compaction", "warning");
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
			if (signal.aborted) return;
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`rewrite-compact: ${message}, using default compaction`, "error");
			return;
		}
	});
}
