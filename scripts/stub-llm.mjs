#!/usr/bin/env node
/**
 * stub-llm.mjs — a dependency-free, scripted stand-in for the DeepSeek
 * chat-completions API.
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
 * WIRE CONTRACT (verified against
 * `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js`):
 *   - `POST {baseURL}/chat/completions` with `stream: true`,
 *     `stream_options.include_usage: true`, `authorization: Bearer …`.
 *   - the response is SSE: `data: <json>\n\n` frames, terminated by the
 *     literal `data: [DONE]\n\n`. `parseSse` dispatches on the blank-line
 *     terminator and treats EOF before `[DONE]` as a truncated stream.
 *   - `translate()` reads ONLY `choices[].delta{content,reasoning_content,
 *     tool_calls[]}` and `choices[].finish_reason`, plus `usage`;
 *     `id`/`object`/`created`/`model` are NOT read by the adapter. They are
 *     emitted anyway so the frames are byte-compatible with a real gateway.
 *   - tool-call fragments sharing one `index` concatenate; `id`/`name` are
 *     identity (a later empty/`null` value means "unchanged"), `arguments`
 *     accumulates. This stub deliberately SPLITS arguments across two frames
 *     so that concatenation is exercised on every call.
 *   - the terminal `finish_reason` is `tool_calls` for a tool step and `stop`
 *     for text; usage rides a trailing `choices: []` chunk (both the
 *     finish-attached and the trailing shape are accepted by the adapter).
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
 *                                                  // request (the last `role: "tool"`
 *                                                  // message is this step's result)
 *       { "say": "final assistant text" }           // finish_reason: "stop"
 *     ]
 *   }
 *
 * The step index is derived from the REQUEST, never from server state: it is
 * the number of `role: "assistant"` messages the harness replayed, so the stub
 * survives restarts and works across turns. A request that carries no `tools`
 * (a side channel such as session titling) is answered with benign text and
 * does not consume a step.
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

const DONE = '[DONE]'
const PORT = Number(process.env.STUB_PORT ?? 8787)
const SCRIPT_PATH = process.env.STUB_SCRIPT ?? ''
const STRICT = process.env.STUB_STRICT !== '0'

/** Frames are `data: <json>\n\n`; the blank line is what dispatches them. */
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
// request inspection
// ---------------------------------------------------------------------------

const CONTENT_KEYS = ['content', 'reasoning_content']

/** Rough token accounting so the harness sees plausible (non-zero) usage. */
function estimateTokens(messages, text) {
    const chars = messages.reduce((total, message) => {
        if (typeof message?.content === 'string') return total + message.content.length
        if (Array.isArray(message?.content)) return total + JSON.stringify(message.content).length
        return total
    }, 0)
    return { prompt: Math.max(1, Math.ceil(chars / 4)), completion: Math.max(1, Math.ceil(text.length / 4)) }
}

/** The newest tool result the harness replayed (for `expectResultContains`). */
function lastToolMessage(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'tool') return messages[index]
    }
    return undefined
}

function toolMessageText(message) {
    const content = message?.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) return JSON.stringify(content)
    return JSON.stringify(content ?? '')
}

/** Names of the tool calls the harness replayed, in order. */
function replayedToolCalls(messages) {
    const names = []
    for (const message of messages) {
        if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue
        for (const call of message.tool_calls) names.push(call?.function?.name ?? '(anonymous)')
    }
    return names
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
 * immediately before the one being decided, and the newest `role: "tool"`
 * message in the request IS that step's result. A missing tool message is a
 * warning, not a failure: some harness paths synthesize the result differently
 * and the run's own artifacts are the authority.
 */
function checkExpectation(previous, messages) {
    const expected = previous?.expectResultContains
    if (!Array.isArray(expected) || expected.length === 0) return
    const tool = lastToolMessage(messages)
    if (tool === undefined) {
        log('WARN', `step ${stepLabel(previous, -1)} expected a tool result but the request replays none`)
        return
    }
    const text = toolMessageText(tool)
    const missing = expected.filter((needle) => !text.includes(needle))
    if (missing.length === 0) {
        log('CHECK', `previous result matches expectResultContains (${expected.length} needle(s))`)
        return
    }
    fatalError(
        `previous tool result does not contain ${JSON.stringify(missing)}`,
        `  --- tool result (first 2000 bytes) ---\n${text.slice(0, 2000)}\n  --- end ---`,
    )
}

// ---------------------------------------------------------------------------
// SSE frames
// ---------------------------------------------------------------------------

function envelope(model, choices, extra = {}) {
    seq += 1
    return {
        id: `chatcmpl-stub-${seq}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices,
        ...extra,
    }
}

function choice(delta, finishReason = null) {
    return { index: 0, delta, finish_reason: finishReason }
}

/** Split a string in two so fragment concatenation is exercised on every call. */
function splitInTwo(text) {
    if (text.length < 2) return [text, '']
    const cut = Math.max(1, Math.floor(text.length / 2))
    return [text.slice(0, cut), text.slice(cut)]
}

function toolFrames(model, call, usage) {
    const args = JSON.stringify(call.arguments ?? {})
    const [first, second] = splitInTwo(args)
    const frames = [
        envelope(model, [choice({ role: 'assistant', content: '' })]),
        envelope(model, [
            choice({
                tool_calls: [
                    {
                        index: 0,
                        id: call.id,
                        type: 'function',
                        function: { name: call.name, arguments: first },
                    },
                ],
            }),
        ]),
    ]
    if (second !== '') {
        // Continuation fragment: the wire repeats identity as null; the adapter
        // must keep the established id/name (acceptIdentity) and append args.
        frames.push(
            envelope(model, [
                choice({
                    tool_calls: [
                        {
                            index: 0,
                            id: null,
                            type: 'function',
                            function: { name: null, arguments: second },
                        },
                    ],
                }),
            ]),
        )
    }
    frames.push(envelope(model, [choice({}, 'tool_calls')]))
    frames.push(usageFrame(model, usage))
    return frames
}

function textFrames(model, text, usage) {
    const parts = text.length > 40 ? [text.slice(0, Math.floor(text.length / 2)), text.slice(Math.floor(text.length / 2))] : [text]
    const frames = [envelope(model, [choice({ role: 'assistant', content: '' })])]
    for (const part of parts) frames.push(envelope(model, [choice({ content: part })]))
    frames.push(envelope(model, [choice({}, 'stop')]))
    frames.push(usageFrame(model, usage))
    return frames
}

function usageFrame(model, usage) {
    return envelope(
        model,
        [],
        {
            usage: {
                prompt_tokens: usage.prompt,
                completion_tokens: usage.completion,
                total_tokens: usage.prompt + usage.completion,
                prompt_cache_hit_tokens: 0,
                prompt_cache_miss_tokens: usage.prompt,
                prompt_tokens_details: { cached_tokens: 0 },
            },
        },
    )
}

function writeFrames(response, frames) {
    for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}${FRAME_TERMINATOR}`)
    response.write(`data: ${DONE}${FRAME_TERMINATOR}`)
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
        // The harness wants more turns than the script declares. Answer with the
        // last step when it is a text step (so the run can end cleanly) and fail
        // loudly either way.
        const last = STEPS[STEPS.length - 1]
        fatalError(
            `harness asked for step ${assistantCount} but the script declares ${STEPS.length}`,
            `  replayed tool calls: ${replayed.join(' → ') || '(none)'}`,
        )
        const frames = last.say !== undefined ? textFrames(model, last.say, usage) : textFrames(model, 'stub: script exhausted.', usage)
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
        log('DECIDE', `${stepLabel(step, assistantCount)} → tool_calls (arguments ${JSON.stringify(step.arguments).length} bytes)`)
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

    log('DECIDE', `${stepLabel(step, assistantCount)} → text/stop (${step.say.length} chars)`)
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
    if (!pathname.endsWith('/chat/completions')) log('WARN', `unexpected path ${pathname}`)
    if (body.stream !== true) log('WARN', 'request did not set stream: true')
    if (body.stream_options?.include_usage !== true) log('WARN', 'request did not set stream_options.include_usage')
    if (Array.isArray(body.tools)) {
        for (const tool of body.tools) {
            if (tool?.type !== 'function') log('WARN', `tools[] entry without type: "function": ${JSON.stringify(tool).slice(0, 120)}`)
        }
    }
    const keys = Object.keys(body)
    log('PROTO', `body keys: ${keys.join(', ')}`)
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
        response.end('{"error":{"message":"stub-llm only serves POST /chat/completions and GET /health"}}\n')
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
