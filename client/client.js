const path = require("path");
const dotenv = require("dotenv");
const mineflayer = require("mineflayer");
const { Vec3 } = require("vec3");
const { RaycastIterator } = require("prismarine-world").iterators;
const { decide } = require("./driver")

dotenv.config({ path: path.resolve(__dirname, ".env") });

// --- Configs ---

const NAME = process.env.BOTNAME;
const HOST = process.env.HOST;
const PORT = 25565
const HORIZONTAL_RANGE = readRange("HORIZONTAL_RANGE");
const VERTICAL_RANGE = readRange("VERTICAL_RANGE");
const VERSION = process.env.MINECRAFT_VERSION;
const VERBOSE = /^(1|true|yes|on)$/i.test(process.env.VERBOSE || "");

function readRange(name) {
  const value = process.env[name] ?? process.env.RANGE;
  if (value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return Number(value);
}

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
  bot.stopDigging();
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
    // if (VERBOSE) console.log("[STATE]:", JSON.stringify(state));

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

    case "look_relative": {
      const { yaw = 0, pitch = 0 } = action;
      if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
        throw new Error("Invalid relative look angles.");
      }
      const nextPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, bot.entity.pitch + pitch));
      const nextYaw = Math.atan2(Math.sin(bot.entity.yaw + yaw), Math.cos(bot.entity.yaw + yaw));
      await bot.look(nextYaw, nextPitch, true);
      return;
    }

    case "attack": {
      const target = targeted_entity();
      if (!target) throw new Error("No entity under the crosshair within reach.");
      bot.attack(target);
      return;
    }

    case "dig": {
      const block = targeted_block();
      if (!block || !bot.canDigBlock(block)) throw new Error("No diggable block under the crosshair within reach.");
      await bot.dig(block);
      return;
    }

    case "place": {
      const block = targeted_block();
      const faces = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)];
      if (!block || !faces[block.face]) throw new Error("No block face under the crosshair within reach.");
      if (!bot.heldItem) throw new Error("No item held for placement.");
      await bot.placeBlock(block, faces[block.face]);
      return;
    }

    default:
      throw new Error(`Unsupported action type: ${action.type}`);
  }
}


// --- Game State Interpretation ---

function targeted_block() {
  const { position, eyeHeight, yaw, pitch } = bot.entity;
  const direction = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  return bot.world.raycast(position.offset(0, eyeHeight, 0), direction, 4.5);
}

function targeted_entity() {
  const { position, eyeHeight, yaw, pitch } = bot.entity;
  const eye = position.offset(0, eyeHeight, 0);
  const direction = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  const block = bot.world.raycast(eye, direction, 3);
  let nearestDistance = block ? eye.distanceTo(block.intersect) : 3;
  let nearest = null;
  for (const entity of Object.values(bot.entities)) {
    if (entity === bot.entity || !entity.position || !entity.width || !entity.height) continue;
    const halfWidth = entity.width / 2;
    const ray = new RaycastIterator(eye, direction, 3);
    const hit = ray.intersect([[-halfWidth, 0, -halfWidth, halfWidth, entity.height, halfWidth]], entity.position);
    if (hit && eye.distanceTo(hit.pos) < nearestDistance) {
      nearest = entity;
      nearestDistance = eye.distanceTo(hit.pos);
    }
  }
  return nearest;
}

function get_state() {
  const entity = bot.entity;
  const targetedBlock = targeted_block();
  const targetedEntity = targeted_entity();

  return {
    position: vector_to_tuple(entity.position),
    velocity: vector_to_tuple(entity.velocity),
    yaw: entity.yaw,
    pitch: entity.pitch,
    heldItem: bot.heldItem ? { name: bot.heldItem.name, count: bot.heldItem.count } : null,
    targetedEntity: targetedEntity ? { name: targetedEntity.name || targetedEntity.username || targetedEntity.type, position: vector_to_tuple(targetedEntity.position) } : null,
    targetedBlock: targetedBlock ? {
      name: targetedBlock.name,
      position: vector_to_tuple(targetedBlock.position),
      face: ["bottom", "top", "north", "south", "west", "east"][targetedBlock.face] || "unknown",
    } : null,
    vision: get_blocks(HORIZONTAL_RANGE, VERTICAL_RANGE),
  };
}

function vector_to_tuple(vector) {
  return [vector.x, vector.y, vector.z];
}

function get_blocks(horizontalRange, verticalRange) {
  const blocks = [];
  const center = bot.entity.position.floored();

  for (let dx = -horizontalRange; dx <= horizontalRange; dx++) {
    for (let dy = -verticalRange; dy <= verticalRange; dy++) {
      for (let dz = -horizontalRange; dz <= horizontalRange; dz++) {
        const position = center.offset(dx, dy, dz);
        const block = bot.blockAt(position);
        
        blocks.push({
          name: block ? block.name : null,
          position: vector_to_tuple(position),
        });
      }
    }
  }

  return {
    horizontalRange,
    verticalRange,
    center: vector_to_tuple(center),
    blocks,
  };
}


module.exports = { bot, get_state };
