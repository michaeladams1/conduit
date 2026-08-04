// calculations.js
//
// Real formulas taken directly from the Condensed Hydraulic Data Book's
// "Miscellaneous Data" section. The model calls these as tools instead of
// doing the arithmetic itself -- language models are unreliable at
// multi-step math, so we give it exact, deterministic functions instead.

/**
 * Hazen-Williams friction loss in feet of head, per 100 feet of pipe.
 * f = 0.2083 * (100/C)^1.85 * q^1.85 / d^4.8655
 */
function frictionLossHazenWilliams({ flowGpm, diameterInches, cFactor = 100 }) {
  const f =
    0.2083 *
    Math.pow(100 / cFactor, 1.85) *
    Math.pow(flowGpm, 1.85) /
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
 * Efficiency as a decimal (0.75 for 75%).
 */
function brakeHorsepower({ gpm, headFeet, pumpEfficiency, specificGravity = 1.0 }) {
  const bhp = (gpm * headFeet * specificGravity) / (3960 * pumpEfficiency);
  return {
    result: bhp,
    unit: "brake horsepower",
    formula: "BHP = GPM x Head x SpGravity / (3960 x Efficiency)",
  };
}

/**
 * Pump efficiency (decimal, e.g. 0.75 for 75%) from known GPM, head, and BHP.
 * Efficiency = GPM x Head / (3960 x BHP)
 */
function pumpEfficiency({ gpm, headFeet, bhp }) {
  const eff = (gpm * headFeet) / (3960 * bhp);
  return {
    result: eff,
    resultAsPercent: eff * 100,
    unit: "decimal (multiply by 100 for percent)",
    formula: "Efficiency = GPM x Head / (3960 x BHP)",
  };
}

/**
 * Head (feet) achievable from a known BHP, efficiency, and GPM.
 * Head = 3960 x Efficiency x BHP / GPM
 */
function headFromBhp({ bhp, pumpEfficiency, gpm }) {
  const head = (3960 * pumpEfficiency * bhp) / gpm;
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
function motorHorsepower({ torqueFtLb, rpm }) {
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
 * Efficiencies as decimals.
 */
function pumpingCostPer1000Gallons({ powerCostPerKwh, headFeet, pumpEfficiency, motorEfficiency }) {
  const cost =
    (0.189 * powerCostPerKwh * headFeet) / (pumpEfficiency * motorEfficiency * 60);
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
function pumpingCostPerHour({ gpm, headFeet, powerCostPerKwh, pumpEfficiency, motorEfficiency }) {
  const cost =
    (0.000189 * gpm * headFeet * powerCostPerKwh) / (pumpEfficiency * motorEfficiency);
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
function pumpingCostPerAcreFoot({ headFeet, powerCostPerKwh, pumpEfficiency, motorEfficiency }) {
  const cost =
    (1.032 * headFeet * powerCostPerKwh) / (pumpEfficiency * motorEfficiency);
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
 * Any of q1, h1, bhp1 may be omitted if not known.
 */
function affinityLaws({ n1Rpm, n2Rpm, q1, h1, bhp1 }) {
  const ratio = n2Rpm / n1Rpm;
  const out = { speedRatio: ratio };
  if (q1 !== undefined) out.q2 = q1 * ratio;
  if (h1 !== undefined) out.h2 = h1 * Math.pow(ratio, 2);
  if (bhp1 !== undefined) out.bhp2 = bhp1 * Math.pow(ratio, 3);
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

function runFormula(name, args) {
  const fn = FORMULAS[name];
  if (!fn) {
    return { error: `Unknown formula "${name}". Available: ${Object.keys(FORMULAS).join(", ")}` };
  }
  try {
    return fn(args);
  } catch (err) {
    return { error: `Calculation failed: ${err.message}. Check that all required inputs were provided.` };
  }
}

module.exports = { FORMULAS, runFormula };
