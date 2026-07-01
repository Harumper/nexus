import { useEffect, useRef, useCallback, useState } from "react";
import type { WSDashboardMessage } from "../types";

interface UseWebSocketOptions {
  onMessage?: (msg: WSDashboardMessage) => void;
  enabled?: boolean;
}

export function useWebSocket({ onMessage, enabled = true }: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // True as long as a connection is desired (enabled + mounted). Set to false on
  // cleanup (enabled→false or unmount) to prevent onclose from restarting a
  // zombie reconnection after an intentional disconnect.
  const wantConnection = useRef(false);

  // Store onMessage in a ref to prevent the hook from reconnecting
  // every time the parent re-renders (onMessage = new reference on
  // each render → useEffect retrigger → close + reopen WS = flapping).
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const connect = useCallback(() => {
    if (!enabled) {
      wantConnection.current = false;
      return;
    }
    wantConnection.current = true;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws/dashboard`;

    // Local auth (post-migration): httpOnly cookie sent automatically
    // by the browser on the WebSocket upgrade — no token on the JS side.
    // Keycloak auth: token on the JS side (kc.token), passed via Sec-WebSocket-Protocol
    // to avoid it appearing in logs/URL.
    const token = sessionStorage.getItem("nexus_token");

    try {
      const ws = token
        ? new WebSocket(wsUrl, ["nexus-auth", token])
        : new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const msg: WSDashboardMessage = JSON.parse(event.data);
          onMessageRef.current?.(msg);
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        setConnected(false);
        // Auto-reconnect only if the connection is still desired.
        // (Otherwise: intentional disconnect enabled→false or unmount → we don't
        // restart a zombie connection that would keep receiving
        // messages.)
        if (wantConnection.current) {
          reconnectTimer.current = setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      // Retry
      reconnectTimer.current = setTimeout(connect, 3000);
    }
  }, [enabled]);

  useEffect(() => {
    connect();
    return () => {
      // Intentional disconnect: prevent the auto-reconnect triggered by onclose.
      wantConnection.current = false;
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg: WSDashboardMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { connected, send };
}
