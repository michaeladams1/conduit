// calculations.js
//
// Real formulas taken directly from the Condensed Hydraulic Data Book's
// "Miscellaneous Data" section. The model calls these as tools instead of
// doing the arithmetic itself -- language models are unreliable at
// multi-step math, so we give it exact, deterministic functions instead.
//
// PARAMETER NAMING (kept consistent across every formula so the model
// doesn't have to guess field names differently per formula):
//   gpm                   - flow rate, US gallons per minute
//   headFeet              - head, in feet
//   diameterInches        - pipe inside diameter, in inches
//   cFactor               - Hazen-Williams C value (optional, default 100)
//   bhp                   - brake horsepower
//   pumpEfficiencyPercent - pump efficiency as a PERCENT, e.g. 75 (not 0.75)
//   motorEfficiencyPercent- motor efficiency as a PERCENT, e.g. 90 (not 0.9)
//   specificGravity       - specific gravity (optional, default 1.0 for water)
//   torqueFtLb, rpm       - for motor horsepower
//   powerCostPerKwh       - electricity cost in dollars per kWh
//   n1Rpm, n2Rpm, q1, h1, bhp1 - for affinity laws (speed change)

function requireNumbers(args, fields) {
  const missing = fields.filter(
    (f) => typeof args[f] !== "number" || Number.isNaN(args[f])
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing or non-numeric required input(s): ${missing.join(", ")}. ` +
        `Ask the caller for these values before calculating.`
    );
  }
}

/**
 * Hazen-Williams friction loss in feet of head, per 100 feet of pipe.
 * f = 0.2083 * (100/C)^1.85 * q^1.85 / d^4.8655
 */
function frictionLossHazenWilliams(args) {
  const { gpm, diameterInches, cFactor = 100 } = args;
  requireNumbers(args, ["gpm", "diameterInches"]);
  const f =
    (0.2083 * Math.pow(100 / cFactor, 1.85) * Math.pow(gpm, 1.85)) /
    Math.pow(diameterInches, 4.8655);
  return {
    result: f,
    unit: "feet of head loss per 100 feet of pipe",
    formula: "f = 0.2083 * (100/C)^1.85 * q^1.85 / d^4.8655",
  };
}

/**
 * Brake horsepower required to pump.
 * BHP = GPM x Head(ft) x Specific Gravity / (3960 x Pump Efficiency)
 */
function brakeHorsepower(args) {
  const { gpm, headFeet, pumpEfficiencyPercent, specificGravity = 1.0 } = args;
  requireNumbers(args, ["gpm", "headFeet", "pumpEfficiencyPercent"]);
  const eff = pumpEfficiencyPercent / 100;
  const bhp = (gpm * headFeet * specificGravity) / (3960 * eff);
  return {
    result: bhp,
    unit: "brake horsepower",
    formula: "BHP = GPM x Head x SpGravity / (3960 x Efficiency)",
  };
}

/**
 * Pump efficiency (returned as a percent, e.g. 75) from known GPM, head, and BHP.
 * Efficiency = GPM x Head / (3960 x BHP)
 */
function pumpEfficiency(args) {
  const { gpm, headFeet, bhp } = args;
  requireNumbers(args, ["gpm", "headFeet", "bhp"]);
  const eff = (gpm * headFeet) / (3960 * bhp);
  return {
    result: eff * 100,
    unit: "percent",
    formula: "Efficiency = GPM x Head / (3960 x BHP)",
  };
}

/**
 * Head (feet) achievable from a known BHP, efficiency, and GPM.
 * Head = 3960 x Efficiency x BHP / GPM
 */
function headFromBhp(args) {
  const { bhp, pumpEfficiencyPercent, gpm } = args;
  requireNumbers(args, ["bhp", "pumpEfficiencyPercent", "gpm"]);
  const eff = pumpEfficiencyPercent / 100;
  const head = (3960 * eff * bhp) / gpm;
  return {
    result: head,
    unit: "feet of head",
    formula: "Head = 3960 x Efficiency x BHP / GPM",
  };
}

/**
 * Motor horsepower required, from torque and speed.
 * HP = Torque(ft-lb) x RPM / 5252
 */
function motorHorsepower(args) {
  const { torqueFtLb, rpm } = args;
  requireNumbers(args, ["torqueFtLb", "rpm"]);
  const hp = (torqueFtLb * rpm) / 5252;
  return {
    result: hp,
    unit: "horsepower",
    formula: "HP = Torque(ft-lb) x RPM / 5252",
  };
}

/**
 * Cost to pump 1000 gallons.
 * Cost = .189 x PowerCostPerKwh x Head / (PumpEff x MotorEff x 60)
 */
function pumpingCostPer1000Gallons(args) {
  const { powerCostPerKwh, headFeet, pumpEfficiencyPercent, motorEfficiencyPercent } = args;
  requireNumbers(args, [
    "powerCostPerKwh",
    "headFeet",
    "pumpEfficiencyPercent",
    "motorEfficiencyPercent",
  ]);
  const pumpEff = pumpEfficiencyPercent / 100;
  const motorEff = motorEfficiencyPercent / 100;
  const cost = (0.189 * powerCostPerKwh * headFeet) / (pumpEff * motorEff * 60);
  return {
    result: cost,
    unit: "dollars per 1000 gallons",
    formula: "Cost = .189 x PowerCost x Head / (PumpEff x MotorEff x 60)",
  };
}

/**
 * Cost per hour of pumping.
 * Cost = .000189 x GPM x Head x PowerCostPerKwh / (PumpEff x MotorEff)
 */
function pumpingCostPerHour(args) {
  const { gpm, headFeet, powerCostPerKwh, pumpEfficiencyPercent, motorEfficiencyPercent } = args;
  requireNumbers(args, [
    "gpm",
    "headFeet",
    "powerCostPerKwh",
    "pumpEfficiencyPercent",
    "motorEfficiencyPercent",
  ]);
  const pumpEff = pumpEfficiencyPercent / 100;
  const motorEff = motorEfficiencyPercent / 100;
  const cost = (0.000189 * gpm * headFeet * powerCostPerKwh) / (pumpEff * motorEff);
  return {
    result: cost,
    unit: "dollars per hour",
    formula: "Cost = .000189 x GPM x Head x PowerCost / (PumpEff x MotorEff)",
  };
}

/**
 * Cost per acre-foot of water pumped.
 * Cost = 1.032 x Head x PowerCostPerKwh / (PumpEff x MotorEff)
 */
function pumpingCostPerAcreFoot(args) {
  const { headFeet, powerCostPerKwh, pumpEfficiencyPercent, motorEfficiencyPercent } = args;
  requireNumbers(args, [
    "headFeet",
    "powerCostPerKwh",
    "pumpEfficiencyPercent",
    "motorEfficiencyPercent",
  ]);
  const pumpEff = pumpEfficiencyPercent / 100;
  const motorEff = motorEfficiencyPercent / 100;
  const cost = (1.032 * headFeet * powerCostPerKwh) / (pumpEff * motorEff);
  return {
    result: cost,
    unit: "dollars per acre-foot",
    formula: "Cost = 1.032 x Head x PowerCost / (PumpEff x MotorEff)",
  };
}

/**
 * Affinity laws: given known performance at speed N1, predict performance
 * at a new speed N2 (impeller diameter held constant).
 * Q2/Q1 = N2/N1 ; H2/H1 = (N2/N1)^2 ; BHP2/BHP1 = (N2/N1)^3
 * q1, h1, bhp1 are each optional -- only the ones the caller knows.
 */
function affinityLaws(args) {
  const { n1Rpm, n2Rpm, q1, h1, bhp1 } = args;
  requireNumbers(args, ["n1Rpm", "n2Rpm"]);
  const ratio = n2Rpm / n1Rpm;
  const out = { speedRatio: ratio };
  if (typeof q1 === "number" && !Number.isNaN(q1)) out.q2 = q1 * ratio;
  if (typeof h1 === "number" && !Number.isNaN(h1)) out.h2 = h1 * Math.pow(ratio, 2);
  if (typeof bhp1 === "number" && !Number.isNaN(bhp1)) out.bhp2 = bhp1 * Math.pow(ratio, 3);
  out.formula = "Q2=Q1*(N2/N1), H2=H1*(N2/N1)^2, BHP2=BHP1*(N2/N1)^3";
  return out;
}

// Dispatch map used by server.js to call a formula by name.
const FORMULAS = {
  friction_loss_hazen_williams: frictionLossHazenWilliams,
  brake_horsepower: brakeHorsepower,
  pump_efficiency: pumpEfficiency,
  head_from_bhp: headFromBhp,
  motor_horsepower: motorHorsepower,
  pumping_cost_per_1000_gallons: pumpingCostPer1000Gallons,
  pumping_cost_per_hour: pumpingCostPerHour,
  pumping_cost_per_acre_foot: pumpingCostPerAcreFoot,
  affinity_laws: affinityLaws,
};

// Per-formula parameter lists, used to build an accurate tool description
// in server.js so the model doesn't have to guess field names.
const FORMULA_PARAMS = {
  friction_loss_hazen_williams: "gpm, diameterInches, cFactor (optional, default 100)",
  brake_horsepower: "gpm, headFeet, pumpEfficiencyPercent (0-100), specificGravity (optional, default 1)",
  pump_efficiency: "gpm, headFeet, bhp",
  head_from_bhp: "bhp, pumpEfficiencyPercent (0-100), gpm",
  motor_horsepower: "torqueFtLb, rpm",
  pumping_cost_per_1000_gallons: "powerCostPerKwh, headFeet, pumpEfficiencyPercent (0-100), motorEfficiencyPercent (0-100)",
  pumping_cost_per_hour: "gpm, headFeet, powerCostPerKwh, pumpEfficiencyPercent (0-100), motorEfficiencyPercent (0-100)",
  pumping_cost_per_acre_foot: "headFeet, powerCostPerKwh, pumpEfficiencyPercent (0-100), motorEfficiencyPercent (0-100)",
  affinity_laws: "n1Rpm, n2Rpm, and any of q1, h1, bhp1 that are known (all optional)",
};

function runFormula(name, args) {
  const fn = FORMULAS[name];
  if (!fn) {
    return { error: `Unknown formula "${name}". Available: ${Object.keys(FORMULAS).join(", ")}` };
  }
  try {
    return fn(args || {});
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { FORMULAS, FORMULA_PARAMS, runFormula };
