import { clamp } from "./utils.js";

export function scoreListing(args) {
  const { itemPrice, parsed, marketStats, preferManualTransmission = false } = args;

  const explanation = [];

  let priceScore = 55;
  let estimatedLow = null;
  let estimatedHigh = null;

  const sampleSize = Number.parseInt(`${marketStats.sample_size ?? 0}`, 10) || 0;
  const medianPrice = marketStats.median_price ? Math.round(Number.parseFloat(`${marketStats.median_price}`)) : null;
  const p25 = marketStats.p25_price ? Math.round(Number.parseFloat(`${marketStats.p25_price}`)) : null;
  const p75 = marketStats.p75_price ? Math.round(Number.parseFloat(`${marketStats.p75_price}`)) : null;

  if (medianPrice !== null && itemPrice !== null) {
    estimatedLow = p25 ?? Math.round(medianPrice * 0.9);
    estimatedHigh = p75 ?? Math.round(medianPrice * 1.1);

    const diffRatio = (medianPrice - itemPrice) / Math.max(medianPrice, 1);
    priceScore = clamp(Math.round(75 + diffRatio * 120));

    if (itemPrice < medianPrice) {
      explanation.push("Below local median asking price.");
    } else if (itemPrice > medianPrice) {
      explanation.push("Above local median asking price.");
    } else {
      explanation.push("At local median asking price.");
    }
  } else {
    explanation.push("Insufficient market sample for price benchmarking.");
  }

  let qualityScore = 60;

  if (parsed.attributes.titleStatus?.includes("clean")) {
    qualityScore += 8;
    explanation.push("Clean title signal found.");
  }

  if (parsed.attributes.transmission === "manual") {
    qualityScore += preferManualTransmission ? 8 : 4;
    explanation.push("Manual transmission detected.");
  }

  if (parsed.attributes.mileage && parsed.attributes.mileage < 120_000) {
    qualityScore += 5;
    explanation.push("Mileage appears reasonable.");
  }

  qualityScore -= parsed.redFlags.length * 10;
  if (parsed.redFlags.length > 0) {
    explanation.push(`Detected ${parsed.redFlags.length} risk flag(s).`);
  }

  qualityScore -= parsed.modifications.filter((mod) => mod.modType === "emissions_risk").length * 12;

  qualityScore = clamp(qualityScore);

  const score = clamp(Math.round(priceScore * 0.6 + qualityScore * 0.4));
  const confidence = clamp(Math.round(Math.min(100, sampleSize * 8 + parsed.evidence.length * 4)) / 100, 0, 1);

  let verdict = "Neutral";
  if (score >= 80) {
    verdict = "Strong candidate";
  } else if (score >= 65) {
    verdict = "Fair value";
  } else if (score < 50) {
    verdict = "Likely overpriced or risky";
  }

  return {
    score,
    priceScore,
    qualityScore,
    confidence,
    estimatedLow,
    estimatedHigh,
    verdict,
    explanation
  };
}
