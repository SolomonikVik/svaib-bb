// @ts-nocheck -- Pi resolves its native SDK aliases when loading this fixture.
// Deterministic model for the real BB -> native Pi verification path.
// No production key or external model endpoint is used by this provider.
import { appendFileSync } from 'node:fs';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

export default function (pi: any) {
  pi.registerProvider('kimi-coding', {
    api: 'svaib-ci', apiKey: 'synthetic-only', baseUrl: 'http://127.0.0.1:9/unused',
    models: [{ id: 'k3.1-pro', name: 'Kimi CI fixture', reasoning: true, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: 2048 }],
    streamSimple(model: any, context: any) {
      const users = context.messages.filter((message: any) => message.role === 'user').map((message: any) =>
        typeof message.content === 'string' ? message.content : message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n'));
      const current = users.at(-1) ?? '';
      const remembers = users.slice(0, -1).some((text: string) => text.includes('STORE_CONTEXT_NONCE:'));
      const text = current.includes('RECALL_CONTEXT_NONCE') ? remembers ? 'MEMORY_OK' : 'MEMORY_MISSING'
        : current.includes('STORE_CONTEXT_NONCE:') ? 'MEMORY_STORED' : 'KIMI_READY';
      appendFileSync(process.env.SVAIB_PI_CHECK_LOG!, JSON.stringify({ provider: model.provider, model: model.id, userMessages: users.length, response: text }) + '\n');
      const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), content: [{ type: 'text', text }], stopReason: 'stop',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end();
      return stream;
    },
  });
}
