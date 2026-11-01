import { createEffect, createRoot, createSignal, onCleanup } from 'solid-js';

/** A pushed message: {topic, seq, ts, type, data} (Technical Design: WebSocket interface). */
export interface HubMessage<T = unknown> {
  topic?: string;
  seq?: number;
  ts?: string;
  type: string;
  data?: T;
  [key: string]: unknown;
}

type Handler = (msg: HubMessage) => void;

interface TopicState {
  lastSeq: number;
  handlers: Set<Handler>;
}

/**
 * Client for the core WebSocket hub. Keeps one socket, authenticates with the first message, and
 * re-subscribes every topic with its lastSeq after a reconnect so no update is missed.
 */
class Hub {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private topics = new Map<string, TopicState>();
  private globalHandlers = new Set<Handler>();
  private retry = 0;
  private reconnectTimer: number | undefined;
  private readonly statusSignal = createRoot(() => createSignal<'connecting' | 'open' | 'closed'>('closed'));
  readonly status = this.statusSignal[0];

  setToken(token: string | null) {
    const changed = token !== this.token;
    this.token = token;
    if (!changed) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (token) this.send({ op: 'auth', token });
      else this.reconnectNow(); // drop the authenticated socket on logout
    } else {
      this.connect();
    }
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    this.statusSignal[1]('connecting');
    ws.onopen = () => {
      this.retry = 0;
      this.statusSignal[1]('open');
      if (this.token) this.send({ op: 'auth', token: this.token });
      for (const [topic, state] of this.topics) this.send({ op: 'subscribe', topic, lastSeq: state.lastSeq });
    };
    ws.onmessage = (e) => this.dispatch(JSON.parse(e.data as string) as HubMessage);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.statusSignal[1]('closed');
      const delay = Math.min(15_000, 500 * 2 ** this.retry++);
      this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
    };
  }

  private reconnectNow() {
    window.clearTimeout(this.reconnectTimer);
    const old = this.ws;
    this.ws = null;
    old?.close();
    this.connect();
  }

  private dispatch(msg: HubMessage) {
    if (msg.topic && typeof msg.seq === 'number') {
      const state = this.topics.get(msg.topic);
      if (state) {
        if (msg.seq <= state.lastSeq && msg.type !== 'SUBSCRIBED') return; // duplicate after replay
        if (msg.type !== 'SUBSCRIBED') state.lastSeq = msg.seq;
        else if (state.lastSeq < 0) state.lastSeq = msg.seq;
        state.handlers.forEach((h) => h(msg));
      }
    }
    if (!msg.topic || msg.type === 'SYNC_GAME_STATE') this.globalHandlers.forEach((h) => h(msg));
  }

  send(payload: Record<string, unknown>): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  subscribe(topic: string, handler: Handler): () => void {
    let state = this.topics.get(topic);
    if (!state) {
      state = { lastSeq: -1, handlers: new Set() };
      this.topics.set(topic, state);
      this.send({ op: 'subscribe', topic, lastSeq: -1 });
    }
    state.handlers.add(handler);
    this.connect();
    return () => {
      const s = this.topics.get(topic);
      if (!s) return;
      s.handlers.delete(handler);
      if (s.handlers.size === 0) {
        this.topics.delete(topic);
        this.send({ op: 'unsubscribe', topic });
      }
    };
  }

  onMessage(handler: Handler): () => void {
    this.globalHandlers.add(handler);
    this.connect();
    return () => this.globalHandlers.delete(handler);
  }
}

export const hub = new Hub();

/** Subscribe to a (possibly changing) topic for the lifetime of the calling component. */
export function useTopic(topic: () => string | null | undefined, handler: Handler) {
  createEffect(() => {
    const t = topic();
    if (!t) return;
    const off = hub.subscribe(t, handler);
    onCleanup(off);
  });
}

export function useHubMessages(handler: Handler) {
  const off = hub.onMessage(handler);
  onCleanup(off);
}
