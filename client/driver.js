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

  const decision = config.decide;
  const question = decision?.request?.questions?.action;
  const criteria = question?.criteria;

  if (
    typeof decision?.url !== "string" ||
    !Number.isSafeInteger(decision.timeoutMs) ||
    decision.timeoutMs <= 0 ||
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

  const analysis = config.analysis;
  if (
    typeof analysis?.url !== "string" ||
    !Number.isSafeInteger(analysis.timeoutMs) ||
    analysis.timeoutMs <= 0 ||
    typeof analysis.request?.model !== "string" ||
    !analysis.request.model.trim() ||
    !Array.isArray(analysis.request.messages) ||
    analysis.request.messages.length === 0
  ) {
    throw new Error("Invalid analysis config.");
  }

  return config;
}

async function decide(state, { config = 1 } = {}) {
  const analysisApiKey = process.env.ANALYSIS_API_KEY;
  const decideApiKey = process.env.DECIDE_API_KEY;

  if (!analysisApiKey?.trim()) {
    throw new Error("ANALYSIS_API_KEY is missing.");
  }
  if (!decideApiKey?.trim()) {
    throw new Error("DECIDE_API_KEY is missing.");
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
  const actions = fillTemplate(settings.actions, variables);
  variables.permitted_actions = JSON.stringify(
    fillTemplate(settings.decide.request.questions.action.criteria, variables),
    null,
    2
  );

  const analysisData = await postJSON(
    settings.analysis.url,
    fillTemplate(settings.analysis.request, variables),
    { apiKey: analysisApiKey, timeoutMs: settings.analysis.timeoutMs, label: "Analysis API" }
  );
  const analysis = analysisData?.choices?.[0]?.message?.content;
  if (typeof analysis !== "string" || !analysis.trim()) {
    throw new Error("Analysis API returned no analysis text.");
  }

  if (/^(1|true|yes|on)$/i.test(process.env.VERBOSE || "")) {
    console.log("[ANALYSIS]:", { analysis, usage: analysisData.usage });
  }

  // Keep the original snapshot; the analysis only advises the selector.
  const request = fillTemplate(settings.decide.request, { ...variables, analysis });
  const data = await postJSON(settings.decide.url, request, {
    apiKey: decideApiKey,
    timeoutMs: settings.decide.timeoutMs,
    label: "Decision API",
  });

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
}

async function postJSON(url, request, { apiKey, timeoutMs, label }) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    const response = await fetch(url, {
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
        `${label} HTTP ${response.status}: ${text.slice(0, 1000)}`
      );
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${label} returned invalid JSON.`);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `${label} timed out after ${timeoutMs}ms.`
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function formatGameState(state) {
  const { vision } = state;
  const horizontalRange = vision?.horizontalRange;
  const verticalRange = vision?.verticalRange;
  const blocks = vision?.blocks;
  const center = vision?.center;

  if (
    !Number.isSafeInteger(horizontalRange) ||
    horizontalRange < 0 ||
    !Number.isSafeInteger(verticalRange) ||
    verticalRange < 0 ||
    !Array.isArray(blocks) ||
    !Array.isArray(center) ||
    center.length !== 3
  ) {
    throw new Error("Invalid vision snapshot.");
  }

  const count = (2 * horizontalRange + 1) ** 2 * (2 * verticalRange + 1);

  if (blocks.length !== count) {
    throw new Error(
      `Expected ${count} blocks, received ${blocks.length}.`
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
    `horizontal_range ${horizontalRange}`,
    `vertical_range ${verticalRange}`,
    `center ${vector(center)}`,
    "blocks",
    ...blocks.map((block) => `${block.name ?? "?"} ${vector(block.position)}`),
  ].join("\n");
}

module.exports = { decide };
