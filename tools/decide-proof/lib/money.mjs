// Exact decimal money for the guard and the recorder. No binary floats anywhere.
// Amounts are BigInt counts of 1e-18 USD ("units"); a price is units per token.
//
//   const price = parsePricePerMillion("0.042");   // USD per million tokens, at most 12 decimals
//   const cost = tokenCost(965, price);            // BigInt units
//   formatUsd(cost)                                // "0.00004053"
//   parseUsd("0.05") >= cost                       // compare with a cap
const DECIMALS = 18;
export const UNITS_PER_USD = 10n ** BigInt(DECIMALS);
const PRICE_DECIMALS = 12;

export class MoneyError extends Error {
  constructor(message) {
    super(message);
    this.name = "MoneyError";
  }
}

const parseScaled = (text, decimals, what) => {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(text).trim());
  if (!m) throw new MoneyError(`${what} must be a plain decimal string such as "0.10"`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new MoneyError(`${what} has more than ${decimals} decimals`);
  return BigInt(m[1] + frac.padEnd(decimals, "0"));
};

export const parseUsd = (text, what = "amount") => parseScaled(text, DECIMALS, what);

// USD per million tokens -> units per token (price x 1e-6 USD x 1e18 = price x 1e12 units)
export const parsePricePerMillion = (text, what = "price") => parseScaled(text, PRICE_DECIMALS, what);

export const tokenCost = (tokens, unitsPerToken) => {
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new MoneyError("token count must be a non-negative integer");
  return BigInt(tokens) * unitsPerToken;
};

export const formatUsd = (units) => {
  const whole = units / UNITS_PER_USD;
  const frac = (units % UNITS_PER_USD).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};
