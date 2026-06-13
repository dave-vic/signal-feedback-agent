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

# ---------------------------------------------------------------------------
# Stage 2: Theme Synthesis  (qwen-max)
# ---------------------------------------------------------------------------

THEME_PROMPT = (
    "You are a product analyst grouping raw feedback into themes. "
    "You will receive a JSON array of feedback items, each with: id (integer), category, summary. "
    "Group them into themes where each theme represents one distinct underlying user problem. "
    "Merge items that describe the same problem even if worded differently — they belong in one theme. "
    "Every item must appear in exactly one theme. Do not leave any items unassigned. "
    "CRITICAL: only use id values from the input. Never invent, guess, or repeat an id.\n\n"
    "GROUPING RULE — when an item touches multiple topics, assign it to the theme of its PRIMARY "
    "user harm: the most fundamental thing that went wrong for the user. "
    "Financial loss takes priority over everything else: if money was deducted and not delivered, "
    "or a refund was not received, that item belongs in the failed-transfers/payments theme — "
    "even if the user also complains about slow support, unclear receipts, or app crashes as "
    "secondary consequences of the same event. "
    "A complaint about waiting for a refund is a transfer failure item, not a support item. "
    "A complaint about a receipt for a failed payment is a transfer failure item, not a receipt item.\n\n"
    "Respond ONLY with a JSON array. Each element must have exactly these keys:\n"
    "  title           — short name for the theme (max 8 words)\n"
    "  problem_statement — one sentence describing the user problem\n"
    "  item_ids        — JSON array of integer ids belonging to this theme\n"
    "No other text, no markdown, no code fences."
)

# Sent when the first theme response contains hallucinated or duplicate item ids.
# Placeholders filled in by pipeline.py:
#   {bad_output}  — the model's previous response
#   {valid_ids}   — comma-separated list of all valid item ids for this run
#   {bad_ids}     — comma-separated list of the specific ids that were invalid
THEME_RETRY_PROMPT = (
    "Your previous response contained item ids that do not exist in the input data. "
    "Invalid ids found: {bad_ids}\n\n"
    "The ONLY valid ids are: {valid_ids}\n\n"
    "Here is what you returned:\n\n{bad_output}\n\n"
    "Rewrite your full response using only valid ids. "
    "Return ONLY a valid JSON array with keys: title, problem_statement, item_ids. "
    "No explanation, no markdown, no code fences."
)

# Sent in a second Qwen call when orphaned items are found after theme synthesis
# (items that ended up in no theme, usually because of dropped hallucinated ids).
# Placeholders filled in by pipeline.py:
#   {existing_themes} — JSON array of existing themes: [{id, title, problem_statement}]
#   {orphan_items}    — JSON array of orphaned items: [{id, category, summary}]
THEME_ORPHAN_PROMPT = (
    "Some feedback items were not assigned to any theme. Your job is to assign each one "
    "to the most appropriate existing theme.\n\n"
    "Existing themes:\n{existing_themes}\n\n"
    "Unassigned items:\n{orphan_items}\n\n"
    "For each unassigned item, choose the single best existing theme by its id. "
    "CRITICAL: only use item ids from the unassigned list and theme ids from the existing themes list. "
    "Respond ONLY with a JSON array where each element has exactly two keys:\n"
    "  item_id  — integer id of the unassigned item\n"
    "  theme_id — integer id of the existing theme it belongs to\n"
    "No other text, no markdown, no code fences."
)
