#!/usr/bin/env node
/**
 * stub-llm.mjs — a dependency-free, scripted stand-in for the DeepSeek
 * **Messages** API.
 *
 * WHY: the suite's end-to-end verification needs a *real* harness driving
 * *real* tools, but the verification sandbox has no `DEEPSEEK_API_KEY` and no
 * budget. This process speaks the exact SSE subset
 * `@deepseek-ai/dsh-llm-deepseek` consumes, so `dsh` runs its real agent loop,
 * real tool dispatch, real plugin hooks and real gates — only the token
 * generator is replaced by a declarative script.
 *
 * WHAT IT IS NOT: it says nothing about model quality. It proves the harness
 * path (tool dispatch → hooks → gates → artifacts), never that a model would
 * choose those calls.
 *
 * WIRE CONTRACT (verified against `@deepseek-ai/dsh-llm-deepseek@0.1.7-rc.1`,
 * `lib/index.js`: `parseSse` ~1520, `translate` ~1660, request builder ~1410):
 *   - `POST {baseURL}/messages` with `stream: true`, `authorization: Bearer …`.
 *     (0.1.5 spoke `/chat/completions` with OpenAI chunks; 0.1.7 switched the
 *     provider to the Messages protocol — this stub followed it.)
 *   - tools travel as `{ name, description, input_schema }`; a tool result is a
 *     `user` message whose content carries `{ type: 'tool_result',
 *     tool_use_id, content }`; the assistant's calls are `{ type: 'tool_use',
 *     id, name, input }` blocks.
 *   - the response is SSE and EVERY frame's JSON must carry a string `type`,
 *     equal to the frame's `event:` name when that line is present (0.1.7
 *     throws `MALFORMED_RESPONSE` otherwise). The vocabulary, in order:
 *       `message_start` → `content_block_start` → `content_block_delta`* →
 *       `content_block_stop` (per block) → `message_delta` → `message_stop`.
 *   - a text block is `{ type: 'text' }` + `delta: { type: 'text_delta', text }`;
 *     a tool block is `{ type: 'tool_use', id, name, input }` +
 *     `delta: { type: 'input_json_delta', partial_json }`. This stub SPLITS a
 *     tool call's JSON across two deltas so fragment concatenation is exercised
 *     on every call.
 *   - `message_delta.delta.stop_reason` settles the turn (`end_turn` for text,
 *     `tool_use` for a call); every block must be closed and the reason present
 *     before `message_stop`, or the translator reports MALFORMED_RESPONSE.
 *   - usage rides `message_start.message.usage.input_tokens` and
 *     `message_delta.usage.output_tokens`; there is NO `data: [DONE]`
 *     terminator in this protocol (`message_stop` ends the stream).
 *
 * USAGE
 *   STUB_SCRIPT=/path/to/script.json [STUB_PORT=8787] node scripts/stub-llm.mjs
 *   node scripts/stub-llm.mjs --check          # validate the script and exit
 *
 * SCRIPT FORMAT (JSON)
 *   {
 *     "steps": [
 *       { "tool": "spec_create", "arguments": { … },
 *         "note": "why this step exists (logged)",
 *         "expectResultContains": ["尚未审批"] },   // optional: asserts THIS step's
 *                                                  // own tool result, evaluated when
 *                                                  // the harness sends the next
 *                                                  // request (the newest tool_result
 *                                                  // block is this step's result)
 *       { "say": "final assistant text" }           // stop_reason: "end_turn"
 *     ]
 *   }
 *
 * The step index is derived from the REQUEST, never from server state: it is
 * the number of assistant messages the harness replayed, so the stub survives
 * restarts and works across turns. A request that carries no `tools` (a side
 * channel such as session titling) is answered with benign text and does not
 * consume a step.
 *
 * FAILURE POLICY: loud, never silent. A protocol violation, a step mismatch or
 * an exhausted script is logged as `STUB-FATAL`, answered with a best-effort
 * frame (so the harness reports a real error instead of hanging), and the
 * process exits non-zero. `scripts/e2e-mission.sh` greps for that marker.
 *
 * LOGS: every request/decision goes to stderr; stdout stays free.
 */

import fs from 'node:fs'
import http from 'node:http'
import process from 'node:process'

const PORT = Number(process.env.STUB_PORT ?? 8787)
const SCRIPT_PATH = process.env.STUB_SCRIPT ?? ''
const STRICT = process.env.STUB_STRICT !== '0'

/** Frames are `event: <type>\ndata: <json>\n\n`; the blank line dispatches them. */
const FRAME_TERMINATOR = '\n\n'

let served = 0
let fatal = 0
let seq = 0

function log(kind, message) {
    process.stderr.write(`[stub-llm] ${kind} ${message}\n`)
}

/** Record a hard failure: loud on stderr, non-zero exit once the reply is out. */
function fatalError(message, detail) {
    fatal += 1
    log('STUB-FATAL', message)
    if (detail !== undefined) process.stderr.write(`${detail}\n`)
}

function die(message, code = 2) {
    log('STUB-FATAL', message)
    process.exit(code)
}

// ---------------------------------------------------------------------------
// script loading
// ---------------------------------------------------------------------------

function loadScript(path) {
    if (path === '') die('STUB_SCRIPT is not set (path to the JSON step script)')
    let raw
    try {
        raw = fs.readFileSync(path, 'utf8')
    } catch (error) {
        die(`cannot read STUB_SCRIPT ${path}: ${error.message}`)
    }
    let parsed
    try {
        parsed = JSON.parse(raw)
    } catch (error) {
        die(`STUB_SCRIPT ${path} is not valid JSON: ${error.message}`)
    }
    const steps = Array.isArray(parsed) ? parsed : parsed?.steps
    if (!Array.isArray(steps) || steps.length === 0) die(`STUB_SCRIPT ${path} declares no steps`)
    for (const [index, step] of steps.entries()) {
        const isTool = typeof step?.tool === 'string' && step.tool !== ''
        const isSay = typeof step?.say === 'string' && step.say !== ''
        if (isTool === isSay) {
            die(`step ${index} must declare exactly one of {tool, say} (got ${JSON.stringify(Object.keys(step ?? {}))})`)
        }
        if (isTool) {
            const args = step.arguments ?? {}
            if (typeof args !== 'object' || args === null || Array.isArray(args)) {
                die(`step ${index} (${step.tool}): "arguments" must be a JSON object`)
            }
        }
        if (step.expectResultContains !== undefined && !Array.isArray(step.expectResultContains)) {
            die(`step ${index}: expectResultContains must be an array of substrings`)
        }
    }
    return steps
}

const STEPS = loadScript(SCRIPT_PATH)

function stepLabel(step, index) {
    const head = step.tool !== undefined ? `tool ${step.tool}` : 'text'
    return `#${index} ${head}${step.note !== undefined ? ` (${step.note})` : ''}`
}

log('INFO', `script ${SCRIPT_PATH}: ${STEPS.length} step(s)`)
for (const [index, step] of STEPS.entries()) log('INFO', `  ${stepLabel(step, index)}`)

if (process.argv.includes('--check')) {
    log('INFO', 'script is valid; --check done')
    process.exit(0)
}

// ---------------------------------------------------------------------------
// request inspection (Messages protocol)
// ---------------------------------------------------------------------------

/** Every block of one message's content, normalising a bare string. */
function blocksOf(message) {
    const content = message?.content
    if (typeof content === 'string') return [{ type: 'text', text: content }]
    if (Array.isArray(content)) return content.filter((block) => block !== null && typeof block === 'object')
    return []
}

/** Tool results the harness replayed: `{ toolUseId, text }`, oldest first. */
function toolResults(messages) {
    const results = []
    for (const message of messages) {
        if (message?.role !== 'user') continue
        for (const block of blocksOf(message)) {
            if (block.type !== 'tool_result') continue
            const inner = block.content
            const text =
                typeof inner === 'string'
                    ? inner
                    : Array.isArray(inner)
                      ? inner
                            .map((entry) => (typeof entry === 'string' ? entry : (entry?.text ?? JSON.stringify(entry))))
                            .join('\n')
                      : JSON.stringify(inner ?? '')
            results.push({ toolUseId: String(block.tool_use_id ?? ''), text })
        }
    }
    return results
}

/** Names of the tool calls the harness replayed, in order. */
function replayedToolCalls(messages) {
    const names = []
    for (const message of messages) {
        if (message?.role !== 'assistant') continue
        for (const block of blocksOf(message)) {
            if (block.type === 'tool_use') names.push(block.name ?? '(anonymous)')
        }
    }
    return names
}

/** Rough token accounting so the harness sees plausible (non-zero) usage. */
function estimateTokens(messages, text) {
    const chars = messages.reduce((total, message) => total + JSON.stringify(message?.content ?? '').length, 0)
    return { prompt: Math.max(1, Math.ceil(chars / 4)), completion: Math.max(1, Math.ceil(text.length / 4)) }
}

function describeRequest(body, messages, tools) {
    const roles = messages.map((message) => message?.role ?? '?').join(',')
    return [
        `model=${body.model}`,
        `messages=${messages.length}`,
        `assistant=${messages.filter((message) => message?.role === 'assistant').length}`,
        `tools=${tools.length}`,
        `stream=${body.stream === true}`,
        `roles=[${roles}]`,
    ].join(' ')
}

/**
 * Verify the step whose result this request replays: `previous` is the step
 * immediately before the one being decided, and the newest `tool_result` block
 * in the request IS that step's result. A missing result is a warning, not a
 * failure: some harness paths synthesize the result differently and the run's
 * own artifacts are the authority.
 */
function checkExpectation(previous, messages) {
    const expected = previous?.expectResultContains
    if (!Array.isArray(expected) || expected.length === 0) return
    const results = toolResults(messages)
    const last = results[results.length - 1]
    if (last === undefined) {
        log('WARN', `step ${stepLabel(previous, -1)} expected a tool result but the request replays none`)
        return
    }
    const missing = expected.filter((needle) => !last.text.includes(needle))
    if (missing.length === 0) {
        log('CHECK', `previous result matches expectResultContains (${expected.length} needle(s))`)
        return
    }
    fatalError(
        `previous tool result does not contain ${JSON.stringify(missing)}`,
        `  --- tool result (first 2000 bytes) ---\n${last.text.slice(0, 2000)}\n  --- end ---`,
    )
}

// ---------------------------------------------------------------------------
// SSE frames (Messages protocol)
// ---------------------------------------------------------------------------

/** One SSE frame: `event:` mirrors the payload's `type`, which 0.1.7 requires. */
function frame(type, payload = {}) {
    seq += 1
    return { event: type, data: { type, ...payload } }
}

function messageStart(model, usage) {
    return frame('message_start', {
        message: {
            id: `msg_stub_${seq}`,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            usage: { input_tokens: usage.prompt, output_tokens: 0 },
        },
    })
}

/** Split a string in two so fragment concatenation is exercised on every call. */
function splitInTwo(text) {
    if (text.length < 2) return [text]
    const cut = Math.max(1, Math.floor(text.length / 2))
    return [text.slice(0, cut), text.slice(cut)]
}

function textBlock(index, text) {
    const frames = [frame('content_block_start', { index, content_block: { type: 'text', text: '' } })]
    for (const part of splitInTwo(text)) {
        frames.push(frame('content_block_delta', { index, delta: { type: 'text_delta', text: part } }))
    }
    frames.push(frame('content_block_stop', { index }))
    return frames
}

function toolBlock(index, call) {
    const args = JSON.stringify(call.arguments ?? {})
    const frames = [
        frame('content_block_start', {
            index,
            content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
        }),
    ]
    for (const part of splitInTwo(args)) {
        frames.push(frame('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: part } }))
    }
    frames.push(frame('content_block_stop', { index }))
    return frames
}

/** A tool-call turn: one open block, its deltas, its close, then settlement. */
function toolFrames(model, call, usage) {
    return [
        messageStart(model, usage),
        ...toolBlock(0, call),
        frame('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: usage.completion } }),
        frame('message_stop'),
    ]
}

/** A text turn. An empty string would be EMPTY_RESPONSE, so say something. */
function textFrames(model, text, usage) {
    const body = text === '' ? 'stub: (empty say step)' : text
    return [
        messageStart(model, usage),
        ...textBlock(0, body),
        frame('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: usage.completion } }),
        frame('message_stop'),
    ]
}

function writeFrames(response, frames) {
    for (const item of frames) {
        response.write(`event: ${item.event}\ndata: ${JSON.stringify(item.data)}${FRAME_TERMINATOR}`)
    }
    response.end()
}

// ---------------------------------------------------------------------------
// decision
// ---------------------------------------------------------------------------

/**
 * Decide the response for one request. Pure observation of the request plus
 * the declarative script — there is no server-side conversation state.
 */
function decide(body, messages, tools) {
    const model = typeof body.model === 'string' && body.model !== '' ? body.model : 'stub-model'
    const assistantCount = messages.filter((message) => message?.role === 'assistant').length
    const replayed = replayedToolCalls(messages)
    const usage = estimateTokens(messages, 'stub')

    if (tools.length === 0) {
        log('SIDE', `request without tools (assistant=${assistantCount}); answering with benign text`)
        return {
            kind: 'text',
            label: 'side-request',
            frames: textFrames(model, 'stub: no tools in this request; nothing to do.', usage),
        }
    }

    if (assistantCount >= STEPS.length) {
        const last = STEPS[STEPS.length - 1]
        fatalError(
            `harness asked for step ${assistantCount} but the script declares ${STEPS.length}`,
            `  replayed tool calls: ${replayed.join(' → ') || '(none)'}`,
        )
        const frames =
            last.say !== undefined ? textFrames(model, last.say, usage) : textFrames(model, 'stub: script exhausted.', usage)
        return { kind: 'text', label: 'script-exhausted', frames }
    }

    const step = STEPS[assistantCount]
    checkExpectation(STEPS[assistantCount - 1], messages)

    if (assistantCount > 0) {
        const previous = STEPS[assistantCount - 1]
        if (previous?.tool !== undefined) {
            const actual = replayed[assistantCount - 1]
            if (actual !== undefined && actual !== previous.tool) {
                fatalError(
                    `step #${assistantCount - 1} executed "${actual}" but the script declared "${previous.tool}"`,
                    `  replayed tool calls: ${replayed.join(' → ')}`,
                )
            }
        }
    }

    if (step.tool !== undefined) {
        log('DECIDE', `${stepLabel(step, assistantCount)} → tool_use (arguments ${JSON.stringify(step.arguments).length} bytes)`)
        return {
            kind: 'tool',
            label: stepLabel(step, assistantCount),
            frames: toolFrames(
                model,
                { id: `call_stub_${assistantCount + 1}`, name: step.tool, arguments: step.arguments ?? {} },
                usage,
            ),
        }
    }

    log('DECIDE', `${stepLabel(step, assistantCount)} → text/end_turn (${step.say.length} chars)`)
    return {
        kind: 'text',
        label: stepLabel(step, assistantCount),
        frames: textFrames(model, step.say, usage),
    }
}

// ---------------------------------------------------------------------------
// protocol assertions (logged, never fatal: the run's artifacts decide)
// ---------------------------------------------------------------------------

function assertProtocol(body, pathname) {
    if (!pathname.endsWith('/messages')) log('WARN', `unexpected path ${pathname} (0.1.7 posts /messages)`)
    if (body.stream !== true) log('WARN', 'request did not set stream: true')
    if (Array.isArray(body.tools)) {
        for (const tool of body.tools) {
            if (typeof tool?.input_schema !== 'object') {
                log('WARN', `tools[] entry without input_schema: ${JSON.stringify(tool).slice(0, 120)}`)
            }
        }
    }
    log('PROTO', `body keys: ${Object.keys(body).join(', ')}`)
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function readBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = []
        request.on('data', (chunk) => chunks.push(chunk))
        request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        request.on('error', reject)
    })
}

const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`).pathname

    if (request.method === 'GET' && pathname === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(`${JSON.stringify({ status: fatal === 0 ? 'ok' : 'fatal', steps: STEPS.length, served, fatal })}\n`)
        return
    }

    if (request.method !== 'POST') {
        log('WARN', `${request.method} ${pathname} → 405`)
        response.writeHead(405, { 'content-type': 'application/json' })
        response.end('{"error":{"message":"stub-llm only serves POST /messages and GET /health"}}\n')
        return
    }

    readBody(request)
        .then((text) => {
            let body
            try {
                body = JSON.parse(text)
            } catch (error) {
                fatalError(`request body is not valid JSON: ${error.message}`, `  raw: ${text.slice(0, 500)}`)
                response.writeHead(400, { 'content-type': 'application/json' })
                response.end('{"error":{"message":"stub-llm could not parse the request body"}}\n')
                return
            }
            const messages = Array.isArray(body.messages) ? body.messages : []
            const tools = Array.isArray(body.tools) ? body.tools : []
            log('REQ', `POST ${pathname} ${describeRequest(body, messages, tools)}`)
            assertProtocol(body, pathname)

            const decision = decide(body, messages, tools)
            served += 1
            response.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache, no-transform',
                connection: 'keep-alive',
                'x-accel-buffering': 'no',
            })
            writeFrames(response, decision.frames)
            if (fatal > 0 && STRICT) {
                // Let the bytes land, then fail the process so the caller cannot
                // mistake a divergent run for a green one.
                setTimeout(() => process.exit(3), 25)
            }
        })
        .catch((error) => {
            fatalError(`request handling failed: ${error.message}`)
            response.writeHead(500, { 'content-type': 'application/json' })
            response.end('{"error":{"message":"stub-llm internal failure"}}\n')
        })
})

server.listen(PORT, '127.0.0.1', () => {
    log('INFO', `listening on http://127.0.0.1:${PORT} (health: /health, script: ${SCRIPT_PATH})`)
})

function shutdown(signal) {
    log('INFO', `${signal}: served ${served} request(s), fatal=${fatal}`)
    server.close(() => process.exit(fatal === 0 ? 0 : 3))
    setTimeout(() => process.exit(fatal === 0 ? 0 : 3), 200).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
