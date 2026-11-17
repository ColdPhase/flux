/**
 * What the schedule will do, in a person's words: the instruction the agent wrote for itself may name its tools (`flux_list_work`, v0.2.1
 * real-model gate row 30). An aside that names them is left out, and a tool named in a sentence reads as words ("list work"). Change still
 * edits the instruction as it is.
 */
export function plainInstruction(text: string): string {
  return text.replace(/[ \t]*\([^()\n]{0,300}\bflux_[a-z_]+[^()\n]{0,300}\)/g, '').replace(/\bflux_([a-z_]+)/g, (_tool, name: string) => name.replace(/_/g, ' '))
    // Words about the answer's cite marks are Flux's own rules for the run, not the person's (train 37 row 16: "…, and the cite mark."): a clause
    // that adds them goes, and so does a sentence that is about them.
    .replace(/,?[ \t]+(?:and|with|plus)[ \t]+(?:the|its|their|a)?[ \t]*cite[ \t]+marks?\b/gi, '')
    .replace(/(^|[.!?][ \t]+)[^.!?\n]*\bcite[ \t]+marks?\b[^.!?\n]*[.!?]?[ \t]*/gi, '$1')
    .trim();
}
