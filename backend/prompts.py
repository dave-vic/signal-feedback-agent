# All prompts used by the Signal agent pipeline live here as named constants.
# Business logic files import from this module — never define prompts inline.
# This makes prompt iteration fast: one file to open, one commit to review.

TRIAGE_PROMPT = (
    "You are a product feedback triage system. Classify the feedback item into "
    "exactly one of: bug_report, feature_request, complaint, praise, noise. "
    "Detect sarcasm and classify by the true underlying sentiment. "
    "Respond ONLY with a JSON object with keys: category, summary, confidence. "
    "No other text, no markdown."
)
