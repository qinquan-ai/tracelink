export interface ScopeSyncOptions {
  /** Receiver `/scopes` endpoint; the client connects to its `/stream` child. */
  endpoint: string;
  /** Delay before reconnecting a broken stream (default: 1000 ms). */
  reconnectDelayMs?: number;
}

interface ScopeEvent {
  enabled?: unknown;
}

function streamEndpoint(endpoint: string): string {
  const normalized = endpoint.replace(/\/+$/, '');
  return normalized.endsWith('/stream') ? normalized : `${normalized}/stream`;
}

export class ScopeSyncClient {
  private abortController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  constructor(
    private readonly options: ScopeSyncOptions,
    private readonly applyEnabled: (enabled: string[]) => void,
  ) {}

  start(): void {
    this.stop();
    const generation = this.generation;
    void this.connect(generation);
  }

  stop(): void {
    this.generation += 1;
    this.abortController?.abort();
    this.abortController = null;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async connect(generation: number): Promise<void> {
    if (generation !== this.generation || typeof fetch === 'undefined') return;

    const controller = new AbortController();
    this.abortController = controller;
    try {
      const response = await fetch(streamEndpoint(this.options.endpoint), {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`Scope stream unavailable: ${response.status}`);
      }
      await this.consume(response.body, generation);
    } catch {
      // Receiver shutdown and network loss are expected during development.
    } finally {
      if (this.abortController === controller) this.abortController = null;
    }

    if (generation === this.generation) this.scheduleReconnect(generation);
  }

  private async consume(
    body: ReadableStream<Uint8Array>,
    generation: number,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventName = '';
    let dataLines: string[] = [];

    const dispatch = (): void => {
      if (eventName !== 'scopes' || dataLines.length === 0) return;
      try {
        const payload = JSON.parse(dataLines.join('\n')) as ScopeEvent;
        if (generation === this.generation && Array.isArray(payload.enabled)) {
          this.applyEnabled(payload.enabled.map((scope) => String(scope)));
        }
      } catch {
        // Ignore malformed control frames and keep the stream alive.
      }
    };

    const processLine = (rawLine: string): void => {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line === '') {
        dispatch();
        eventName = '';
        dataLines = [];
      } else if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      }
    };

    try {
      while (generation === this.generation) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          processLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private scheduleReconnect(generation: number): void {
    const delayMs = this.options.reconnectDelayMs ?? 1000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(generation);
    }, Math.max(delayMs, 10));
    const timer = this.reconnectTimer as { unref?: () => void };
    if (typeof timer.unref === 'function') timer.unref();
  }
}
