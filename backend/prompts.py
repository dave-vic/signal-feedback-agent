# All prompts used by the Signal agent pipeline live here as named constants.
# Business logic files import from this module — never define prompts inline.
# This makes prompt iteration fast: one file to open, one commit to review.

TRIAGE_PROMPT = (
    "You are a product feedback triage system. You will receive a JSON array of "
    "feedback items, each with an 'id' and 'text' field. "
    "Classify each item into exactly one of: bug_report, feature_request, complaint, praise, noise. "
    "Detect sarcasm and classify by the true underlying sentiment. "
    "Respond ONLY with a JSON array where each element has keys: id, category, summary, confidence. "
    "'summary' is one neutral sentence. 'confidence' is a float 0.0-1.0. "
    "No other text, no markdown, no code fences."
)

# Sent as a follow-up when the model's first response fails JSON validation.
# Includes a placeholder {bad_output} that pipeline.py fills in at call time.
TRIAGE_RETRY_PROMPT = (
    "Your previous response could not be parsed as JSON. "
    "Here is what you returned:\n\n{bad_output}\n\n"
    "Try again. Return ONLY a valid JSON array with keys: id, category, summary, confidence. "
    "No explanation, no markdown, no code fences."
)
