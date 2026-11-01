import { A } from '@solidjs/router';
import { createEffect, createSignal, For, on, Show } from 'solid-js';
import { get, post } from '../api/client';
import type { ChatMessage } from '../api/types';
import { auth } from '../lib/auth';
import { useTopic } from '../lib/ws';
import { toast } from './toast';
import { Card, Empty } from './ui';

export function Chat(props: { roomId: string | null | undefined; title?: string; class?: string }) {
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [text, setText] = createSignal('');
  // oxlint-disable-next-line no-unassigned-vars -- assigned by Solid's ref={list}
  let list: HTMLDivElement | undefined;

  createEffect(
    on(
      () => props.roomId,
      async (roomId) => {
        setMessages([]);
        if (roomId) setMessages(await get<ChatMessage[]>(`/api/chat/rooms/${roomId}/messages`));
        scrollDown();
      },
    ),
  );
  useTopic(
    () => (props.roomId ? `chat:${props.roomId}` : null),
    (msg) => {
      if (msg.type !== 'CHAT_MESSAGE') return;
      const m = msg.data as ChatMessage;
      setMessages((all) => (all.some((x) => x.id === m.id) ? all : [...all.slice(-99), m]));
      scrollDown();
    },
  );

  const scrollDown = () => queueMicrotask(() => list?.scrollTo({ top: list.scrollHeight, behavior: 'smooth' }));

  const send = async (e: Event) => {
    e.preventDefault();
    const body = text().trim();
    if (!body || !props.roomId) return;
    setText('');
    try {
      await post(`/api/chat/rooms/${props.roomId}/messages`, { message: body });
    } catch (err) {
      toast.error(err);
      setText(body);
    }
  };

  return (
    <Card title={props.title ?? 'Chat'} class={`flex flex-col ${props.class ?? ''}`}>
      <div ref={list} class="flex h-64 flex-col gap-2 overflow-y-auto px-4 py-3 text-sm" aria-live="polite">
        <Show when={messages().length} fallback={<Empty title="No messages yet" icon="💬">Say hi to the room.</Empty>}>
          <For each={messages()}>
            {(m) => (
              <p class="leading-snug">
                <span class={`font-semibold ${m.username === auth.user()?.username ? 'text-gold-300' : 'text-ink-300'}`}>{m.username}</span>{' '}
                <span class="text-ink-100 [overflow-wrap:anywhere]">{m.message}</span>
              </p>
            )}
          </For>
        </Show>
      </div>
      <Show when={auth.user()} fallback={<p class="border-t border-ink-700/60 px-4 py-3 text-center text-xs text-ink-400"><A href="/login" class="text-gold-300">Log in</A> to chat</p>}>
        <form class="flex gap-2 border-t border-ink-700/60 p-3" onSubmit={send}>
          <input
            class="h-9 flex-1 rounded-lg border border-ink-600 bg-ink-950/60 px-3 text-sm focus:border-gold-500 focus:outline-none"
            placeholder="Message…"
            maxLength={500}
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
            aria-label="Chat message"
          />
          <button type="submit" class="rounded-lg bg-ink-700 px-3 text-sm font-semibold hover:bg-ink-600">Send</button>
        </form>
      </Show>
    </Card>
  );
}
