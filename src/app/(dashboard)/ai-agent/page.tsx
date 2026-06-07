import { redirect } from 'next/navigation'

/**
 * /ai-agent is just a section landing — the only page currently
 * implemented is /knowledge. Redirect rather than render an empty
 * shell so we don't have to maintain it twice. A future overview /
 * runs / learning queue page would replace this redirect.
 */
export default function AiAgentIndex() {
  redirect('/ai-agent/knowledge')
}
