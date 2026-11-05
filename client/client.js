const path = require("path");
const dotenv = require("dotenv");
const mineflayer = require("mineflayer");
const { decide } = require("./driver")

dotenv.config({ path: path.resolve(__dirname, ".env") });

// --- Configs ---

const NAME = process.env.BOTNAME;
const HOST = process.env.HOST;
const PORT = 25565
const RANGE = Number(process.env.RANGE);
const VERSION = process.env.MINECRAFT_VERSION;
const VERBOSE = /^(1|true|yes|on)$/i.test(process.env.VERBOSE || "");


// --- Arguments ---

let config = 1;

const args = process.argv.slice(2);
for (const arg of args) {
    const separatorIndex = arg.indexOf(":");
    if (separatorIndex === -1) {
        continue;
    }

    const key = arg.slice(0, separatorIndex);
    const value = arg.slice(separatorIndex + 1);

    if (key === "config") {
        const parsedConfig = Number(value);

        if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsedConfig) || parsedConfig < 1) {
            console.error("Config must be a positive integer!");
            process.exit(1);
        }

        config = parsedConfig;
    }
}


// --- Connections ---

const bot = mineflayer.createBot({
    username: NAME,
    host: HOST,
    port: PORT,
    version: VERSION,
    hideErrors: true
});

let ready = false;
let busy = false;
let generation = 0;

bot.on("login", () => {
    const bot_socket = bot._client.socket;
    console.log(
        `[INFO]: Logged in to ${bot_socket.server || bot_socket._host}`
    );
})

bot.on("kicked", (reason, loggedIn) => {
    if (loggedIn) {
        console.log(`[INFO]: Kicked from server: ${reason}`);
    } else {
        console.log(`[INFO]: Kicked whilst trying to connect: ${reason}`);
    }
})

bot.on("spawn", () => {
  generation++;
  ready = true;
  console.log("[INFO]: Bro spawned!");
});

bot.on("death", () => {
  ready = false;
  generation++;
  bot.clearControlStates();
});

bot.on("end", () => {
    ready = false;
    generation++;
});

bot.on("error", (error) => {
    console.error("[ERROR]: Mineflayer:", error.message || error);
});


// --- Dispatch ---

bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString()
    const m = text.match(/BTN:(\S+)/)
    if (!m) return
    if (m[1] == 'trigger') {
        execute();
    }
})


// --- Action selection ---

async function execute() {
  if (!ready || !bot.entity) {
    console.warn("[WARN]: Bot is not ready.");
    return;
  }

  if (busy) {
    if (VERBOSE) console.log("[INFO]: Trigger ignored: bot is busy.");
    return;
  }

  busy = true;
  const currentGeneration = generation;

  try {
    const state = get_state();

    if (VERBOSE) console.log("[STATE]:", JSON.stringify(state));

    const action = await decide(state, { config });

    if (!ready || generation !== currentGeneration) {
      console.warn("[WARN]: Discarded a stale decision.");
      return;
    }

    if (VERBOSE) console.log("[ACTION]:", action);

    await perform(action);
  } catch (error) {
    console.error("[ERROR]: Decision cycle:", error.message || error);
  } finally {
    bot.clearControlStates();
    busy = false;
  }
}

async function perform(action) {
  if (!action || typeof action !== "object") {
    throw new Error("Driver returned an invalid action.");
  }

  switch (action.type) {
    case "noop":
      return;

    case "move": {
      const allowed = new Set([
        "forward",
        "back",
        "left",
        "right",
        "jump",
        "sprint",
        "sneak",
      ]);

      const { controls, durationMs } = action;

      if (
        !Array.isArray(controls) ||
        !controls.every((control) => allowed.has(control))
      ) {
        throw new Error("Invalid movement controls.");
      }

      if (
        !Number.isFinite(durationMs) ||
        durationMs <= 0 ||
        durationMs > 5000
      ) {
        throw new Error("durationMs must be between 0 and 5000 ms.");
      }

      try {
        for (const control of controls) {
          bot.setControlState(control, true);
        }

        await new Promise((resolve) => setTimeout(resolve, durationMs));
      } finally {
        bot.clearControlStates();
      }

      return;
    }

    case "look": {
      const { yaw, pitch } = action;

      if (
        !Number.isFinite(yaw) ||
        !Number.isFinite(pitch) ||
        Math.abs(pitch) > Math.PI / 2
      ) {
        throw new Error("Invalid yaw/pitch; angles must be in radians.");
      }

      await bot.look(yaw, pitch, true);
      return;
    }

    default:
      throw new Error(`Unsupported action type: ${action.type}`);
  }
}


// --- Game State Interpretation ---

function get_state() {
  const entity = bot.entity;

  return {
    position: vector_to_tuple(entity.position),
    velocity: vector_to_tuple(entity.velocity),
    yaw: entity.yaw,
    pitch: entity.pitch,
    vision: get_cube(RANGE),
  };
}

function vector_to_tuple(vector) {
  return [vector.x, vector.y, vector.z];
}

function get_cube(range) {
  const blocks = [];
  const center = bot.entity.position.floored();

  for (let dx = -range; dx <= range; dx++) {
    for (let dy = -range; dy <= range; dy++) {
      for (let dz = -range; dz <= range; dz++) {
        const block = bot.blockAt(center.offset(dx, dy, dz));
        
        blocks.push({
          name: block ? block.name : null,
        });
      }
    }
  }

  return {
    range,
    center: vector_to_tuple(center),
    blocks,
  };
}


module.exports = { bot, get_state };