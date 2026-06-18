import { useEffect, useRef, useState, useCallback } from 'react';
import type { WSMessage, TranslationJob } from '../types';

type JobUpdateCallback = (job: TranslationJob) => void;

export function useWebSocket(onJobUpdate?: JobUpdateCallback) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [connected, setConnected] = useState(false);
  const callbackRef = useRef(onJobUpdate);
  callbackRef.current = onJobUpdate;

  const connect = useCallback(() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    wsRef.current = ws;

    ws.addEventListener('open', () => {
      setConnected(true);
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
    });

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data) as WSMessage;
        if (msg.type === 'job:update' && msg.job) {
          callbackRef.current?.(msg.job);
        }
      } catch {
        // ignore malformed
      }
    });

    ws.addEventListener('close', () => {
      setConnected(false);
      reconnectTimer.current = setTimeout(connect, 3000);
    });
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const subscribe = useCallback((jobId: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', jobId }));
    }
  }, []);

  return { connected, subscribe };
}