import { WebSocketServer, WebSocket } from "ws";
import dotenv from "dotenv";

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-realtime";
const VOICE = process.env.OPENAI_VOICE || "marin";
const PORT = 3000;

if (!OPENAI_API_KEY) {
  console.error('Falta la variable "OPENAI_API_KEY".');
  process.exit(1);
}

// Eventos nuevos de OpenAI -> nombres que entiende la pagina
const RENAME = {
  "conversation.item.added": "conversation.item.created",
  "response.output_audio.delta": "response.audio.delta",
  "response.output_audio.done": "response.audio.done",
  "response.output_audio_transcript.delta": "response.audio_transcript.delta",
  "response.output_audio_transcript.done": "response.audio_transcript.done",
  "response.output_text.delta": "response.text.delta",
  "response.output_text.done": "response.text.done",
};

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "/", `https://${req.headers.host}`);
  if (url.pathname !== "/") {
    ws.close();
    return;
  }

  console.log(`Conectando a OpenAI con modelo "${MODEL}" y voz "${VOICE}"...`);
  const openai = new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
  });

  const queue = [];
  let voiceSet = false;

  const forward = (data) => {
    try {
      let event = JSON.parse(data.toString());

      // Traduce la configuracion de la pagina al formato nuevo de OpenAI
      if (event.type === "session.update") {
        const old = event.session || {};
        const output = { format: { type: "audio/pcm", rate: 24000 } };
        if (!voiceSet) {
          output.voice = VOICE;
          voiceSet = true;
        }
        const session = {
          type: "realtime",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              turn_detection: { type: "server_vad" },
            },
            output,
          },
        };
        if (old.instructions) session.instructions = old.instructions;
        event = { type: "session.update", session };
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
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (event.type === "error") {
      console.error("ERROR DE OPENAI:", JSON.stringify(event.error));
    } else if (!event.type.includes("delta")) {
      console.log(`OpenAI -> Navegador: ${event.type}`);
    }
    if (RENAME[event.type]) event.type = RENAME[event.type];
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
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
