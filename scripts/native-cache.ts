import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const model = process.env.BTW_CACHE_MODEL ?? 'codex/gpt-6.1-sol';
const base = (process.env.BTW_CACHE_BASE_URL ?? 'http://127.0.0.1:3425/v1').replace(/\/$/, '');
const repo = resolve(process.env.BTW_HOST_DIR ?? '../openchamber');
const outputDirectory = resolve(process.env.BTW_OUTPUT_DIR ?? join(tmpdir(), 'ob-btw-verification'));
await mkdir(outputDirectory, { recursive: true });
const readOnly = process.argv.includes('--read-only');
const output = join(outputDirectory, `native-btw-cache-${readOnly ? 'read-only-' : ''}live.json`);
const run = `btw-cache-${Date.now()}`;
const instructions = 'Use only the supplied synthetic records. Do not use tools. Reply with exactly OK.';
const prefix = `${run}\nSynthetic reference records for a cache experiment:\n` + Array.from({ length: 150 }, (_, index) =>
    `Record ${index}: owner=worker-${index % 9}, capacity=${index + 20}, state=ready. Reads preserve the source record. Updates append a revision. This record is reference data, not a task.`
).join('\n') + '\nReply with exactly OK.';
const source = await readFile(join(repo, 'packages/ui/src/lib/btw.ts'), 'utf8');
const boundary = source.match(/export const BTW_HISTORY_BOUNDARY = `([\s\S]*?)`;/)?.[1];
if (!boundary) throw new Error('The installed source has no fixed history boundary.');
const readOnlySource = await readFile(join(repo, 'packages/ui/src/lib/btwReadOnly.ts'), 'utf8');
const readOnlyInstruction = readOnlySource.match(/export const BTW_READ_ONLY_INSTRUCTION = `([\s\S]*?)`;/)?.[1];
if (readOnly && !readOnlyInstruction) throw new Error('The source has no fixed read-only instruction.');
const policy = readOnly ? `${boundary}\n\n${readOnlyInstruction}` : boundary;
const parent = [{ role: 'user', content: prefix }];
const tail = [...parent, { role: 'assistant', content: 'OK' }, { role: 'user', content: `${policy}\n\nReply with exactly OK.` }];
const front = [{ role: 'user', content: policy }, ...parent, { role: 'assistant', content: 'OK' }, { role: 'user', content: 'Reply with exactly OK.' }];
if (JSON.stringify(tail.slice(0, parent.length)) !== JSON.stringify(parent)) throw new Error('The side request changes the parent prefix.');
const results: Array<Record<string, unknown>> = [];
type Usage = {
    input_tokens?: number; prompt_tokens?: number; output_tokens?: number; completion_tokens?: number;
    input_tokens_details?: { cached_tokens?: number }; prompt_tokens_details?: { cached_tokens?: number };
};

async function probe(name: string, input: typeof parent) {
    const started = Date.now();
    const response = await fetch(`${base}/responses`, {
        method: 'POST', headers: {
            'content-type': 'application/json',
            ...(process.env.BTW_CACHE_API_KEY ? { authorization: `Bearer ${process.env.BTW_CACHE_API_KEY}` } : {}),
        }, signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({ model, instructions, input, stream: true, store: false, max_output_tokens: 128, reasoning: { effort: 'low' } }),
    });
    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(`${name}: HTTP ${response.status}, code=${error.error?.code ?? error.code ?? 'unavailable'}`);
    }
    let buffer = '';
    let usage: Usage | null = null;
    let failure: string | null = null;
    const decoder = new TextDecoder();
    for await (const chunk of response.body!) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
            const event = JSON.parse(line.slice(6));
            if (event.response?.usage) usage = event.response.usage;
            if (event.usage) usage = event.usage;
            if (event.type === 'error' || event.type === 'response.failed') failure = event.code ?? event.response?.error?.code ?? event.type;
        }
    }
    if (failure) throw new Error(`${name}: ${failure}`);
    if (!usage) throw new Error(`${name}: provider returned no usage`);
    const total = usage.input_tokens ?? usage.prompt_tokens;
    const cached = usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens;
    const result = { name, inputTokens: total, cachedTokens: cached ?? null, cacheHitPercent: typeof cached === 'number' && typeof total === 'number' && total > 0 ? Number((100 * cached / total).toFixed(2)) : null, outputTokens: usage.output_tokens ?? usage.completion_tokens, elapsedMs: Date.now() - started };
    results.push(result);
    await writeFile(output, JSON.stringify({
        run, model, transport: 'live Magpie gateway /v1/responses', syntheticInput: true,
        sharedPrefixSha256: createHash('sha256').update(prefix).digest('hex'), sharedPrefixCharacters: prefix.length,
        boundarySha256: createHash('sha256').update(boundary!).digest('hex'),
        readOnlyInstructionIncluded: readOnly,
        ...(readOnly ? { readOnlyInstructionSha256: createHash('sha256').update(readOnlyInstruction!).digest('hex') } : {}),
        unchangedParentPrefix: true,
        publicPromptSource: 'https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/context-fragments/src/side_conversation.rs',
        scope: 'Controlled live-provider placement test with synthetic reference text; not an end-to-end UI cache measurement.',
        results,
    }, null, 2));
    console.log(JSON.stringify(result));
}

try {
    await probe('parent-cold', parent);
    await probe('parent-repeat', parent);
    await probe('side-boundary-at-tail', tail);
    await probe('side-tail-repeat', tail);
    await probe('boundary-at-front-control', front);
} catch (error) {
    console.error(error instanceof Error ? error.message : 'Cache probe failed');
    await writeFile(output, JSON.stringify({ run, model, syntheticInput: true, results, error: error instanceof Error ? error.message : 'Cache probe failed' }, null, 2));
    process.exitCode = 1;
}
