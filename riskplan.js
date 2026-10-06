/**
 * forge — which verification a change of a given risk needs (pure, zero
 * dependencies). Split out of plannerisk.js so autonomy-level2.js, which is on
 * the agent's startup path, does not load the whole plan-risk module for one
 * lookup table. plannerisk.js re-exports it, so existing imports still work.
 */
export function verificationPlanForRisk(risk) {
  switch (risk) {
    case "trivial":
    case "low":
      return { level: "LOW", targeted: true, regression: false, integration: false, adversarialReview: false, runtimeValidation: false, why: "low risk — targeted verification" }
    case "medium":
      return { level: "MEDIUM", targeted: true, regression: true, integration: false, adversarialReview: false, runtimeValidation: false, why: "medium risk — targeted + regression" }
    case "high":
      return { level: "HIGH", targeted: true, regression: true, integration: true, adversarialReview: false, runtimeValidation: false, why: "high risk — targeted + regression + integration" }
    case "critical":
      return { level: "CRITICAL", targeted: true, regression: true, integration: true, adversarialReview: true, runtimeValidation: true, why: "critical risk — full relevant verification + adversarial review + runtime validation" }
    default:
      return verificationPlanForRisk("medium")
  }
}
