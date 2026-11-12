/**
 * Rendering of one child's result for the `team_delegate` report.
 *
 * Split out of `tools.ts` for the structural ratchet (that file is already over
 * the file-length limit and must not grow): the report text is pure formatting,
 * and keeping it here also makes "how a child's stop reason is phrased" a single
 * place an audit can read.
 *
 * @module dsh-role-guard/child-output
 */

/** Chinese label for a child's terminal stop reason (unknown values pass through). */
export function stopReasonText(stopReason: string): string {
    switch (stopReason) {
        case 'completed':
            return '完成'
        case 'aborted':
            return '被取消'
        case 'error':
            return '模型/传输错误'
        case 'max-tokens':
            return '达到 token 上限'
        case 'refusal':
            return '子代理拒绝执行'
        default:
            return stopReason
    }
}

/** Join a child's output blocks into text; non-text blocks are labelled. */
export function renderChildOutput(output: readonly { type: string; text?: string }[] | undefined): string {
    if (output === undefined || output.length === 0) return '(子代理没有产出文本)'
    return output
        .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : `[${block.type}]`))
        .join('\n')
}
