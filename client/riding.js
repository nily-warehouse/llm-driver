// Mineflayer handles boarding, but some versions leave bot.vehicle set when
// set_passengers removes the bot from a vehicle's passenger list.
function trackDismounts(bot) {
  bot._client.on("set_passengers", ({ entityId, passengers }) => {
    const vehicle = bot.vehicle;
    if (!bot.entity || !vehicle || vehicle.id !== entityId || passengers.includes(bot.entity.id)) return;

    bot.vehicle = null;
    bot.entity.vehicle = null;
    if (vehicle.passengers) {
      vehicle.passengers = vehicle.passengers.filter((passenger) => passenger.id !== bot.entity.id);
    }
    bot.emit("dismount", vehicle);
  });

  const reset = () => {
    bot.vehicle = null;
    if (bot.entity) bot.entity.vehicle = null;
  };
  bot.on("death", reset);
  bot.on("respawn", reset);
  bot.on("end", reset);
}

async function waitForVehicle(bot, expectedId, isCurrent, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (isCurrent()) {
    if ((bot.vehicle?.id ?? null) === expectedId) return;
    if (Date.now() >= deadline) throw new Error("Server did not confirm the riding state change.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Riding action interrupted.");
}

module.exports = { trackDismounts, waitForVehicle };
