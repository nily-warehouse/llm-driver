const path = require("path");
const dotenv = require("dotenv");
const mineflayer = require("mineflayer");


// --- Configs ---

// env

const env_path = path.resolve(__dirname, ".env");
dotenv.config({ path: env_path });

let   NAME = process.env.BOTNAME;
const HOST = process.env.HOST;
const PORT = 25565
const RANGE = Number(process.env.RANGE);
const VERSION = process.env.MINECRAFT_VERSION;
const VERBOSE = /^(1|true|yes|on)$/i.test(process.env.VERBOSE || "");


// args

const args = process.argv.slice(2);

let config = 1;

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

function login() {
    const bot_socket = bot._client.socket;
    console.log(
        `[INFO]: Logged in to ${bot_socket.server || bot_socket._host}`
    );
}

function kicked(reason, loggedIn) {
    if (loggedIn) {
        console.log(`[INFO]: Kicked from server: ${reason}`);
    } else {
        console.log(`[INFO]: Kicked whilst trying to connect: ${reason}`);
    }
}

function spawn() {
    console.log('[INFO]: Bro spawned!')
}

function end() {
    // console.log('[INFO]: Done!')
}

bot.on("login", login);
bot.on('spawn', spawn);
bot.on("kicked", kicked);
bot.on("error", error => {
    console.error(`[ERROR]: Mineflayer error: ${error.message || error}`);
});
// bot.on("end", end);


// --- Dispatch ---

bot.on('message', (jsonMsg) => {
  const text = jsonMsg.toString()
  const m = text.match(/BTN:(\S+)/)
  if (!m) return
  onButtonPressed(m[1])
})

function onButtonPressed(command) {
    if (command == 'trigger') {
        execute()
    }
}


// --- Action selection ---

function execute() {
    // TODO: send get_state() to driver.js and fetch action and call perform
}

function perform() {
    // TODO: perform fetched action from driver
}


// --- Game State Interpretation ---

function get_state() {
    const entity = bot.entity;
    
    return {
        velocity: vector_to_tuple(bot.entity.velocity),
        yaw:   bot.entity.yaw,
        pitch: bot.entity.pitch,
        vision: get_cube(RANGE)
    };
}

function vector_to_tuple(vector) {
    return [vector.x, vector.y, vector.z];
}

function get_cube(range) {
    const result = [];
    const center = bot.entity.position.floored();

    for (let dx = -range; dx <= range; dx++) {
        for (let dy = -range; dy <= range; dy++) {
            for (let dz = -range; dz <= range; dz++) {
                const pos = center.offset(dx, dy, dz);
                const block = bot.blockAt(pos);

                if (!block) continue;

                result.push({
                    name: block.name,
                });
            }
        }
    }
    return result;
}


module.exports = { bot, get_state };