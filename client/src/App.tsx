import { useState, useEffect, useRef, useCallback } from "react";
import { RealtimeClient } from "@openai/realtime-api-beta";
// @ts-expect-error - External library without type definitions
import { WavRecorder, WavStreamPlayer } from "./lib/wavtools/index.js";
import { instructions } from "./conversation_config.js";
import sarahImg from "./sarah.png";
import "./App.css";

// ====== PERSONALIZA AQUI ======
const NOMBRE = "Sarah";
const SUBTITULO = "Asistente virtual de IA · Jose Quito";
const COLOR_FONDO_1 = "#3B1450"; // morado oscuro
const COLOR_FONDO_2 = "#6A2C7A"; // morado
const COLOR_ACENTO = "#D9774B"; // terracota
const COLOR_TEXTO = "#F8F1E7"; // crema
// ==============================

const clientRef = { current: null as RealtimeClient | null };
const wavRecorderRef = { current: null as WavRecorder | null };
const wavStreamPlayerRef = { current: null as WavStreamPlayer | null };

export function App() {
  const params = new URLSearchParams(window.location.search);
  const RELAY_SERVER_URL = params.get("wss");
  const [connectionStatus, setConnectionStatus] = useState<
    "disconnected" | "connecting" | "connected"
  >("disconnected");
  const [level, setLevel] = useState(0);

  if (!clientRef.current) {
    clientRef.current = new RealtimeClient({
      url: RELAY_SERVER_URL || undefined,
    });
  }
  if (!wavRecorderRef.current) {
    wavRecorderRef.current = new WavRecorder({ sampleRate: 24000 });
  }
  if (!wavStreamPlayerRef.current) {
    wavStreamPlayerRef.current = new WavStreamPlayer({ sampleRate: 24000 });
  }
  const isConnectedRef = useRef(false);
  const connectConversation = useCallback(async () => {
    if (isConnectedRef.current) return;
    isConnectedRef.current = true;
    setConnectionStatus("connecting");
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    const wavStreamPlayer = wavStreamPlayerRef.current;
    if (!client || !wavRecorder || !wavStreamPlayer) return;

    try {
      await wavRecorder.begin();
      await wavStreamPlayer.connect();
      await client.connect();

      setConnectionStatus("connected");

      client.on("error", (event: any) => {
        console.error(event);
        setConnectionStatus("disconnected");
      });

      client.on("disconnected", () => {
        setConnectionStatus("disconnected");
      });

      client.sendUserMessageContent([
        {
          type: `input_text`,
          text: `Hello!`,
        },
      ]);

      client.updateSession({
        turn_detection: { type: "server_vad" },
      });

      if (wavRecorder.recording) {
        await wavRecorder.pause();
      }

      if (!wavRecorder.recording) {
        await wavRecorder.record((data: { mono: Float32Array }) =>
          client.appendInputAudio(data.mono)
        );
      }
    } catch (error) {
      console.error("Connection error:", error);
      setConnectionStatus("disconnected");
    }
  }, []);

  const errorMessage = !RELAY_SERVER_URL
    ? 'Missing required "wss" parameter in URL'
    : (() => {
        try {
          new URL(RELAY_SERVER_URL);
          return null;
        } catch {
          return 'Invalid URL format for "wss" parameter';
        }
      })();

  useEffect(() => {
    if (!errorMessage) {
      connectConversation();
      const wavStreamPlayer = wavStreamPlayerRef.current;
      const client = clientRef.current;
      if (!client || !wavStreamPlayer) return;

      client.updateSession({ instructions: instructions });

      client.on("error", (event: any) => console.error(event));
      client.on("conversation.interrupted", async () => {
        const trackSampleOffset = await wavStreamPlayer.interrupt();
        if (trackSampleOffset?.trackId) {
          const { trackId, offset } = trackSampleOffset;
          await client.cancelResponse(trackId, offset);
        }
      });
      client.on("conversation.updated", async ({ item, delta }: any) => {
        client.conversation.getItems();
        if (delta?.audio) {
          wavStreamPlayer.add16BitPCM(delta.audio, item.id);
        }
        if (item.status === "completed" && item.formatted.audio?.length) {
          const wavFile = await WavRecorder.decode(
            item.formatted.audio,
            24000,
            24000
          );
          item.formatted.file = wavFile;
        }
      });

      return () => {
        client.reset();
      };
    }
  }, [errorMessage]);

  // Anima el borde de la foto segun el volumen de la voz de Sarah
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const player = wavStreamPlayerRef.current;
      try {
        if (player?.analyser) {
          const values: Float32Array = player.getFrequencies("voice").values;
          let sum = 0;
          for (let i = 0; i < values.length; i++) sum += values[i];
          const avg = values.length ? sum / values.length : 0;
          setLevel((prev) => prev * 0.6 + Math.min(1, avg * 2.5) * 0.4);
        }
      } catch {
        // sin audio todavia
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const estado = errorMessage
    ? "Error de configuración"
    : connectionStatus === "connected"
    ? "En línea"
    : connectionStatus === "connecting"
    ? "Conectando..."
    : "Desconectada";
  const colorEstado =
    connectionStatus === "connected" && !errorMessage
      ? "#4ADE80"
      : connectionStatus === "connecting" && !errorMessage
      ? "#FBBF24"
      : "#F87171";

  const ring = 12 + level * 40;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "3vh",
        background: `radial-gradient(circle at 50% 40%, ${COLOR_FONDO_2}, ${COLOR_FONDO_1} 70%)`,
        color: COLOR_TEXTO,
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        overflow: "hidden",
      }}
    >
      <img
        src={sarahImg}
        alt={NOMBRE}
        style={{
          width: "42vh",
          height: "42vh",
          objectFit: "cover",
          objectPosition: "50% 25%",
          borderRadius: "50%",
          border: `6px solid ${COLOR_ACENTO}`,
          boxShadow: `0 0 ${ring}px ${ring / 2}px ${COLOR_ACENTO}aa`,
          transform: `scale(${1 + level * 0.06})`,
          transition: "box-shadow 80ms linear, transform 80ms linear",
        }}
      />
      <div style={{ fontSize: "9vh", fontWeight: 700, lineHeight: 1 }}>
        {NOMBRE}
      </div>
      <div style={{ fontSize: "3.6vh", opacity: 0.9 }}>{SUBTITULO}</div>
      <div
        style={{
          position: "absolute",
          bottom: "4vh",
          display: "flex",
          alignItems: "center",
          gap: "1vh",
          fontSize: "2.4vh",
          opacity: 0.85,
        }}
      >
        <span
          style={{
            width: "1.8vh",
            height: "1.8vh",
            borderRadius: "50%",
            background: colorEstado,
            display: "inline-block",
          }}
        />
        {estado}
      </div>
    </div>
  );
}

export default App;
