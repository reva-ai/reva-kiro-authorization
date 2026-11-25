"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.truncateAssistantOutput = truncateAssistantOutput;
// Reva's finalize request truncates the stored output at 16 KiB. Stay under
// that so the summarize call is not rejected as invalid.
const MAX_OUTPUT_BYTES = 16 * 1024;
/** Truncate to Reva's stored-output budget (UTF-8 byte length). */
function truncateAssistantOutput(text) {
    const trimmed = (text || '').trim();
    if (!trimmed)
        return '';
    const buf = Buffer.from(trimmed, 'utf8');
    if (buf.length <= MAX_OUTPUT_BYTES)
        return trimmed;
    // Cutting at a byte offset can split a multi-byte character; decoding
    // replaces the broken tail with U+FFFD, which is dropped so the output
    // never ends in a replacement character.
    return buf.subarray(0, MAX_OUTPUT_BYTES).toString('utf8').replace(/�+$/, '');
}
