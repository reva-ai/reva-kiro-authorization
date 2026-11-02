"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readStdin = readStdin;
exports.stripBom = stripBom;
// Reads the hook payload from stdin.
//
// The BOM strip is not cosmetic. Every entrypoint does `JSON.parse(await
// readStdin())`, and `JSON.parse` rejects a leading U+FEFF outright — so a
// single invisible byte ahead of the payload turns into "failing closed"
// on PreToolUse, which in the Kiro IDE blocks the tool call. Producing a
// hard deny because of a byte-order mark would be an absurd way to break a
// developer's session.
//
// Anything that hands a hook its payload through a Windows shell can add
// one: PowerShell's pipeline emits UTF-8-with-BOM by default in Windows
// PowerShell 5.1, which is exactly how this was found — piping a test
// payload into the compiled entrypoint produced
// `Unexpected token '﻿' ... is not valid JSON`. kiro-cli itself pipes
// raw bytes and does not add one, so this is defence against the
// environment around the hook rather than against either host, and costs
// one comparison per invocation.
function readStdin() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => {
            data += chunk;
        });
        process.stdin.on('end', () => resolve(stripBom(data)));
        process.stdin.on('error', reject);
    });
}
// Only a LEADING mark is removed, and only one: a U+FEFF anywhere else is
// legitimate content (it is a zero-width no-break space) and rewriting the
// middle of a payload would be a worse bug than the one being fixed.
function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
