import { WebSocketServer, WebSocket } from "ws";
import dotenv from "dotenv";

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-realtime-preview";
const VOICE = process.env.OPENAI_VOICE || "coral";
const PORT = 3000;

if (!OPENAI_API_KEY) {
  console.error('Falta la variable "OPENAI_API_KEY".');
  process.exit(1);
}

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "/", `https://${req.headers.host}`);
  if (url.pathname !== "/") {
    ws.close();
    return;
  }

  console.log(`Conectando a OpenAI con modelo "${MODEL}" y voz "${VOICE}"...`);
  const openai = new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  const queue = [];
  let voiceSet = false;

  const forward = (data) => {
    try {
      const event = JSON.parse(data.toString());
      if (event.type === "session.update" && event.session) {
        if (!voiceSet) {
          event.session.voice = VOICE;
          voiceSet = true;
        } else {
          delete event.session.voice;
        }
      }
      if (event.type !== "input_audio_buffer.append") {
        console.log(`Navegador -> OpenAI: ${event.type}`);
      }
      openai.send(JSON.stringify(event));
    } catch (e) {
      console.error("Error procesando mensaje del navegador:", e.message);
    }
  };

  openai.on("open", () => {
    console.log("Conectado a OpenAI correctamente");
    while (queue.length) forward(queue.shift());
  });

  openai.on("message", (data) => {
    const text = data.toString();
    try {
      const event = JSON.parse(text);
      if (event.type === "error") {
        console.error("ERROR DE OPENAI:", JSON.stringify(event.error));
      } else if (!event.type.includes("delta")) {
        console.log(`OpenAI -> Navegador: ${event.type}`);
      }
    } catch {}
    if (ws.readyState === WebSocket.OPEN) ws.send(text);
  });

  openai.on("close", (code, reason) => {
    console.log(`OpenAI cerro la conexion (${code}): ${reason.toString()}`);
    ws.close();
  });

  openai.on("error", (e) => {
    console.error("Error de conexion con OpenAI:", e.message);
    ws.close();
  });

  ws.on("message", (data) => {
    if (openai.readyState === WebSocket.OPEN) forward(data);
    else queue.push(data);
  });

  ws.on("close", () => {
    if (openai.readyState === WebSocket.OPEN) openai.close();
  });
});

console.log(`Servidor escuchando en el puerto ${PORT}`);
