const fs = require("node:fs/promises");
const path = require("node:path");

const hasOwn = (object, key) =>
  Object.prototype.hasOwnProperty.call(object, key);

// Replace placeholders inside string values, without eval.
function fillTemplate(value, variables) {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}$/);
    if (exact && hasOwn(variables, exact[1]) && variables[exact[1]] !== undefined) {
      return variables[exact[1]];
    }
    return value.replace(
      /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g,
      (placeholder, name) => {
        if (!hasOwn(variables, name) || !["string", "number"].includes(typeof variables[name])) {
          throw new Error(`Unknown config placeholder: ${placeholder}`);
        }

        return variables[name];
      }
    );
  }

  if (Array.isArray(value)) {
    return value.map((item) => fillTemplate(item, variables));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        fillTemplate(item, variables),
      ])
    );
  }

  return value;
}

async function loadConfig(number) {
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error("Config must be a positive integer.");
  }

  const filename = path.join(
    __dirname,
    "configs",
    `${number}.json`
  );

  let config;

  try {
    config = JSON.parse(await fs.readFile(filename, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot load config "${filename}": ${error.message}`
    );
  }

  const question = config.request?.questions?.action;
  const criteria = question?.criteria;

  if (
    typeof config.url !== "string" ||
    !Number.isSafeInteger(config.timeoutMs) ||
    config.timeoutMs <= 0 ||
    question?.type !== "choice" ||
    !criteria ||
    typeof criteria !== "object" ||
    Array.isArray(criteria) ||
    Object.keys(criteria).length === 0 ||
    !config.actions ||
    typeof config.actions !== "object" ||
    Array.isArray(config.actions)
  ) {
    throw new Error("Invalid decision config.");
  }

  for (const choice of Object.keys(criteria)) {
    if (!hasOwn(config.actions, choice)) {
      throw new Error(`Missing action mapping for "${choice}".`);
    }
  }

  return config;
}

async function decide(state, { config = 1 } = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is missing.");
  }

  // Read on each trigger, so config edits apply without restarting.
  const settings = await loadConfig(config);

  const { movementDurationMs, turnStepDegrees } = settings;
  if (!Number.isFinite(movementDurationMs) || movementDurationMs <= 0 || movementDurationMs > 5000 ||
      !Number.isFinite(turnStepDegrees?.yaw) || turnStepDegrees.yaw <= 0 || turnStepDegrees.yaw > 180 ||
      !Number.isFinite(turnStepDegrees?.pitch) || turnStepDegrees.pitch <= 0 || turnStepDegrees.pitch > 180) {
    throw new Error("Invalid movementDurationMs or turnStepDegrees in decision config.");
  }
  const yawStep = turnStepDegrees.yaw * Math.PI / 180;
  const pitchStep = turnStepDegrees.pitch * Math.PI / 180;
  const variables = {
    preface: settings.preface,
    target: settings.target,
    game_state: formatGameState(state),
    movementDurationMs,
    yawStepDegrees: turnStepDegrees.yaw,
    pitchStepDegrees: turnStepDegrees.pitch,
    yawStep,
    negativeYawStep: -yawStep,
    pitchStep,
    negativePitchStep: -pitchStep,
  };
  const request = fillTemplate(settings.request, variables);
  const actions = fillTemplate(settings.actions, variables);

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    settings.timeoutMs
  );

  try {
    const response = await fetch(settings.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `Decision API HTTP ${response.status}: ${text.slice(0, 1000)}`
      );
    }

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Decision API returned invalid JSON.");
    }

    const answer = data?.answers?.action;
    const choice = answer?.choice;

    if (
      answer?.type !== "choice" ||
      typeof choice !== "string" ||
      !hasOwn(request.questions.action.criteria, choice) ||
      !hasOwn(settings.actions, choice)
    ) {
      throw new Error(
        `Invalid decision response: ${JSON.stringify(data).slice(0, 1000)}`
      );
    }

    if (/^(1|true|yes|on)$/i.test(process.env.VERBOSE || "")) {
      console.log("[DECISION]:", {
        choice,
        confidence: answer.confidence,
        usage: data.usage,
      });
    }

    return actions[choice];
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `Decision API timed out after ${settings.timeoutMs}ms.`
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function formatGameState(state) {
  const { vision } = state;
  const range = vision?.range;
  const blocks = vision?.blocks;
  const center = vision?.center;

  if (
    !Number.isSafeInteger(range) ||
    range < 0 ||
    !Array.isArray(blocks) ||
    !Array.isArray(center) ||
    center.length !== 3
  ) {
    throw new Error("Invalid vision snapshot.");
  }

  const side = 2 * range + 1;

  if (blocks.length !== side ** 3) {
    throw new Error(
      `Expected ${side ** 3} blocks, received ${blocks.length}.`
    );
  }

  const vector = (value) => value.join(" ");
  const targetedBlock = state.targetedBlock;

  return [
    `position ${vector(state.position)}`,
    `velocity ${vector(state.velocity)}`,
    `yaw ${state.yaw}`,
    `pitch ${state.pitch}`,
    state.heldItem ? `held_item ${state.heldItem.name} ${state.heldItem.count}` : "held_item none",
    state.targetedEntity ? `targeted_entity ${state.targetedEntity.name} ${vector(state.targetedEntity.position)}` : "targeted_entity none",
    targetedBlock
      ? `targeted_block ${targetedBlock.name} ${vector(targetedBlock.position)} face ${targetedBlock.face}`
      : "targeted_block none",
    `range ${range}`,
    `center ${vector(center)}`,
    "blocks",
    ...blocks.map((block) => `${block.name ?? "?"} ${vector(block.position)}`),
  ].join("\n");
}

module.exports = { decide };
