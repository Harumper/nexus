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
  // Vrai tant qu'une connexion est désirée (enabled + monté). Mis à false au
  // cleanup (enabled→false ou démontage) pour empêcher onclose de relancer une
  // reconnexion zombie après une coupure volontaire.
  const wantConnection = useRef(false);

  // Stocker onMessage dans une ref pour éviter que le hook se reconnecte
  // chaque fois que le parent re-render (onMessage = nouvelle référence à
  // chaque render → useEffect retrigger → close + reopen WS = flapping).
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

    // Auth locale (post-migration) : cookie httpOnly envoyé automatiquement
    // par le navigateur sur l'upgrade WebSocket — pas de token côté JS.
    // Auth Keycloak : token côté JS (kc.token), passé via Sec-WebSocket-Protocol
    // pour éviter qu'il apparaisse dans les logs/URL.
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
        // Reconnexion auto seulement si la connexion est toujours désirée.
        // (Sinon : coupure volontaire enabled→false ou démontage → on ne
        // relance pas une connexion zombie qui continuerait à recevoir des
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
      // Coupure volontaire : empêcher la reconnexion auto déclenchée par onclose.
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
