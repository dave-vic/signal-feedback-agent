"""
Signal — Agent pipeline (Stages 0–4)
=====================================
Stage 0: INGEST            — parse CSV into FeedbackItem rows
Stage 1: TRIAGE            — classify items with qwen-turbo, mark exclusions, audit everything
Stage 2: THEME SYNTHESIS   — group items into themes with qwen-max, validate evidence chain
Stage 3: PRIORITIZATION    — score themes P1-P4 with qwen-max, write rationale
Stage 4: TICKET DRAFTING   — draft sprint-ready tickets for P1/P2 themes with qwen-max

This module has no Flask imports. It's pure Python that talks to the database
and the Qwen API. app.py calls run_pipeline() in a background thread.
"""

import os
import csv
import json
import logging
import requests
from datetime import datetime, timezone

from models import db, PipelineRun, FeedbackItem, AuditEvent, Theme
from prompts import (TRIAGE_PROMPT, TRIAGE_RETRY_PROMPT,
                     THEME_PROMPT, THEME_RETRY_PROMPT, THEME_ORPHAN_PROMPT,
                     PRIORITY_PROMPT, PRIORITY_RETRY_PROMPT,
                     TICKET_PROMPT, TICKET_RETRY_PROMPT)

logger = logging.getLogger(__name__)

# Qwen endpoint and model choices — match ARCHITECTURE.md
QWEN_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"
TRIAGE_MODEL = "qwen-turbo"
THEME_MODEL = "qwen-max"

BATCH_SIZE = 10   # items per Qwen call during triage
VALID_CATEGORIES = {"bug_report", "feature_request", "complaint", "praise", "noise"}

# Timeout for qwen-max calls (theming, prioritization).
# qwen-max on 180+ summaries can take 60-90s; 120s gives headroom for retries.
QWEN_MAX_TIMEOUT = 120

# Temperature for qwen-max calls — low value for near-deterministic output.
# High temperature (default ~0.7-1.0) causes wildly different theme counts/groupings
# across runs on identical input. 0.1 keeps output consistent without removing
# all creativity.
QWEN_MAX_TEMPERATURE = 0.1


# ---------------------------------------------------------------------------
# Qwen API helper
# ---------------------------------------------------------------------------

def _call_qwen(messages: list, model: str, temperature: float | None = None) -> dict:
    """
    Send a messages list to Qwen and return the raw response dict.
    Raises requests.RequestException on network/HTTP errors.
    The caller is responsible for parsing and validating the content.

    temperature: pass QWEN_MAX_TEMPERATURE for qwen-max calls; omit for qwen-turbo
                 (triage) which uses the model default.
    """
    api_key = os.environ.get("DASHSCOPE_API_KEY")
    if not api_key:
        raise RuntimeError("DASHSCOPE_API_KEY environment variable is not set")

    # Determine timeout: qwen-max needs more headroom than qwen-turbo
    timeout = QWEN_MAX_TIMEOUT if model == THEME_MODEL else 90

    body: dict = {"model": model, "messages": messages}
    if temperature is not None:
        body["temperature"] = temperature

    resp = requests.post(
        QWEN_URL,
        json=body,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        timeout=timeout,
    )
    resp.raise_for_status()
    return resp.json()


def _extract_text(qwen_response: dict) -> str:
    """Pull the assistant's message text out of a Qwen response dict."""
    return qwen_response["choices"][0]["message"]["content"]


def _extract_usage(qwen_response: dict) -> dict:
    """Pull token counts out of a Qwen response dict."""
    usage = qwen_response.get("usage", {})
    return {
        "tokens_in": usage.get("prompt_tokens"),
        "tokens_out": usage.get("completion_tokens"),
    }


def _parse_json_reply(text: str):
    """
    Parse a model reply as JSON, tolerantly.

    qwen-max sometimes wraps its output in markdown code fences
    (```json ... ```) even when explicitly told not to. This helper
    strips those before parsing so a fence never causes a parse failure.

    Returns the parsed Python object, or raises json.JSONDecodeError.
    """
    stripped = text.strip()
    # Remove opening fence: ```json or ```
    if stripped.startswith("```"):
        stripped = stripped[stripped.index("\n") + 1:] if "\n" in stripped else stripped[3:]
    # Remove closing fence
    if stripped.endswith("```"):
        stripped = stripped[: stripped.rfind("```")]
    return json.loads(stripped.strip())


# ---------------------------------------------------------------------------
# Triage response validation
# ---------------------------------------------------------------------------

def _validate_triage_response(raw_text: str, expected_ids: list[int]) -> list[dict] | None:
    """
    Try to parse raw_text as a JSON array of triage results.
    Returns the parsed list if valid, or None if anything is wrong.

    A valid response is a JSON array where every element has:
      - id (int, must be in expected_ids)
      - category (one of VALID_CATEGORIES)
      - summary (non-empty string)
      - confidence (float 0-1)
    """
    try:
        parsed = json.loads(raw_text)
    except json.JSONDecodeError:
        return None

    if not isinstance(parsed, list):
        return None

    validated = []
    seen_ids = set()
    for item in parsed:
        if not isinstance(item, dict):
            return None
        # Check all required keys exist
        if not all(k in item for k in ("id", "category", "summary", "confidence")):
            return None
        if item["id"] not in expected_ids:
            return None
        if item["category"] not in VALID_CATEGORIES:
            return None
        if not isinstance(item["summary"], str) or not item["summary"].strip():
            return None
        try:
            conf = float(item["confidence"])
            if not (0.0 <= conf <= 1.0):
                return None
        except (TypeError, ValueError):
            return None
        seen_ids.add(item["id"])
        validated.append(item)

    # Every expected ID must have a result
    if set(expected_ids) != seen_ids:
        return None

    return validated


# ---------------------------------------------------------------------------
# Audit helper
# ---------------------------------------------------------------------------

def _write_audit(app, run_id: int, stage: str, action: str,
                 detail: dict, model: str = None,
                 tokens_in: int = None, tokens_out: int = None):
    """
    Write one AuditEvent row inside an app context.
    detail is a plain Python dict — we serialize it to JSON here.
    """
    with app.app_context():
        event = AuditEvent(
            run_id=run_id,
            stage=stage,
            action=action,
            detail_json=json.dumps(detail),
            model_used=model,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
        )
        db.session.add(event)
        db.session.commit()


def _update_run(app, run_id: int, **kwargs):
    """Update fields on a PipelineRun row."""
    with app.app_context():
        run = db.session.get(PipelineRun, run_id)
        for key, value in kwargs.items():
            setattr(run, key, value)
        db.session.commit()


# ---------------------------------------------------------------------------
# Stage 0: INGEST
# ---------------------------------------------------------------------------

def run_ingest(app, run_id: int, filepath: str) -> int:
    """
    Parse the CSV at filepath and create FeedbackItem rows.
    Returns the number of items created.
    Tolerant of extra columns and missing optional fields.
    """
    items_created = 0

    with app.app_context():
        with open(filepath, newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            rows = list(reader)

        for row in rows:
            # Strip whitespace from all values
            row = {k.strip(): (v.strip() if v else None) for k, v in row.items()}

            text = row.get("text")
            if not text:
                continue  # skip blank rows

            source = row.get("source") or "other"
            if source not in ("app_store", "support", "nps", "other"):
                source = "other"

            rating_raw = row.get("rating")
            try:
                rating = float(rating_raw) if rating_raw else None
            except ValueError:
                rating = None

            item = FeedbackItem(
                run_id=run_id,
                source=source,
                text=text,
                date=row.get("date"),
                rating=rating,
            )
            db.session.add(item)
            items_created += 1

        db.session.commit()

    _write_audit(app, run_id, "ingest", "csv_parsed", {
        "filepath": filepath,
        "items_created": items_created,
    })

    _update_run(app, run_id, status="triaging")
    return items_created


# ---------------------------------------------------------------------------
# Stage 1: TRIAGE
# ---------------------------------------------------------------------------

def _find_exact_duplicates(items: list) -> set[int]:
    """
    Return a set of FeedbackItem IDs that are exact text duplicates.
    The first occurrence of each text is kept; subsequent ones are excluded.
    Comparison is case-insensitive and whitespace-normalised.
    """
    seen_texts = {}
    duplicate_ids = set()
    for item in items:
        normalized = " ".join(item.text.lower().split())
        if normalized in seen_texts:
            duplicate_ids.add(item.id)
        else:
            seen_texts[normalized] = item.id
    return duplicate_ids


def run_triage(app, run_id: int):
    """
    Classify every non-excluded FeedbackItem for this run using qwen-turbo.
    Items are sent in batches of BATCH_SIZE. Each batch gets one Qwen call,
    with one corrective retry on malformed output.
    Noise items and exact duplicates are marked excluded after classification.
    One AuditEvent is written per batch.
    """
    with app.app_context():
        items = FeedbackItem.query.filter_by(run_id=run_id, excluded=False).all()

    if not items:
        _write_audit(app, run_id, "triage", "skipped", {"reason": "no items to triage"})
        return

    # Mark exact duplicates before any Qwen calls
    duplicate_ids = _find_exact_duplicates(items)
    if duplicate_ids:
        with app.app_context():
            for item_id in duplicate_ids:
                item = db.session.get(FeedbackItem, item_id)
                item.excluded = True
                item.exclusion_reason = "exact_duplicate"
            db.session.commit()
        _write_audit(app, run_id, "triage", "duplicates_excluded", {
            "count": len(duplicate_ids),
            "item_ids": list(duplicate_ids),
        })
        # Reload items without the duplicates
        with app.app_context():
            items = FeedbackItem.query.filter_by(run_id=run_id, excluded=False).all()

    # Split into batches
    batches = [items[i:i + BATCH_SIZE] for i in range(0, len(items), BATCH_SIZE)]
    total_classified = 0
    total_noise_excluded = 0

    for batch_num, batch in enumerate(batches):
        batch_payload = [{"id": item.id, "text": item.text} for item in batch]
        expected_ids = [item.id for item in batch]

        messages = [
            {"role": "system", "content": TRIAGE_PROMPT},
            {"role": "user", "content": json.dumps(batch_payload)},
        ]

        # --- First attempt ---
        try:
            raw_response = _call_qwen(messages, TRIAGE_MODEL)
            reply_text = _extract_text(raw_response)
            usage = _extract_usage(raw_response)
        except requests.RequestException as e:
            _write_audit(app, run_id, "triage", "batch_api_error", {
                "batch_num": batch_num,
                "item_ids": expected_ids,
                "error": str(e),
            })
            logger.error("Triage batch %d API error: %s", batch_num, e)
            continue

        results = _validate_triage_response(reply_text, expected_ids)

        # --- Corrective retry if validation failed ---
        if results is None:
            logger.warning("Triage batch %d: invalid response, retrying", batch_num)
            retry_messages = messages + [
                {"role": "assistant", "content": reply_text},
                {"role": "user", "content": TRIAGE_RETRY_PROMPT.format(bad_output=reply_text)},
            ]
            try:
                raw_response = _call_qwen(retry_messages, TRIAGE_MODEL)
                reply_text = _extract_text(raw_response)
                usage = _extract_usage(raw_response)
                results = _validate_triage_response(reply_text, expected_ids)
            except requests.RequestException as e:
                _write_audit(app, run_id, "triage", "batch_retry_api_error", {
                    "batch_num": batch_num,
                    "item_ids": expected_ids,
                    "error": str(e),
                })
                logger.error("Triage batch %d retry API error: %s", batch_num, e)
                continue

        # --- Graceful failure if retry also failed ---
        if results is None:
            _write_audit(app, run_id, "triage", "batch_failed_validation", {
                "batch_num": batch_num,
                "item_ids": expected_ids,
                "raw_reply": reply_text,
            }, model=TRIAGE_MODEL, **usage)
            logger.error("Triage batch %d: response invalid after retry, skipping", batch_num)
            continue

        # --- Write results to DB ---
        noise_excluded_this_batch = []
        with app.app_context():
            for result in results:
                item = db.session.get(FeedbackItem, result["id"])
                if item is None:
                    continue
                item.category = result["category"]
                item.summary = result["summary"]
                item.confidence = float(result["confidence"])

                if result["category"] == "noise":
                    item.excluded = True
                    item.exclusion_reason = "noise"
                    noise_excluded_this_batch.append(item.id)

            db.session.commit()

        total_classified += len(results)
        total_noise_excluded += len(noise_excluded_this_batch)

        _write_audit(app, run_id, "triage", "batch_classified", {
            "batch_num": batch_num,
            "item_ids": expected_ids,
            "noise_excluded": noise_excluded_this_batch,
        }, model=TRIAGE_MODEL,
           tokens_in=usage.get("tokens_in"),
           tokens_out=usage.get("tokens_out"))

    # Update run counts
    with app.app_context():
        total = FeedbackItem.query.filter_by(run_id=run_id).count()
        excluded = FeedbackItem.query.filter_by(run_id=run_id, excluded=True).count()
        run = db.session.get(PipelineRun, run_id)
        run.counts_json = json.dumps({
            "items_total": total,
            "excluded": excluded,
            "themes": 0,
            "tickets": 0,
        })
        db.session.commit()

    _write_audit(app, run_id, "triage", "triage_complete", {
        "total_classified": total_classified,
        "noise_excluded": total_noise_excluded,
        "duplicate_ids_excluded": len(duplicate_ids),
    })


# ---------------------------------------------------------------------------
# Stage 2: THEME SYNTHESIS
# ---------------------------------------------------------------------------

def _validate_theme_response(parsed: list, valid_ids: set) -> tuple[list, set]:
    """
    Check a parsed list of theme dicts for hallucinated or duplicate item_ids.

    Returns (cleaned_themes, bad_ids) where:
      - cleaned_themes is the list with only known, non-duplicated ids kept
      - bad_ids is the set of ids that were invalid (empty = all good)

    A theme whose item_ids list becomes empty after cleaning is removed entirely.
    This function never raises — it always returns something usable.
    """
    bad_ids = set()
    seen_globally = set()   # an id should appear in at most one theme
    cleaned = []

    for theme in parsed:
        if not isinstance(theme, dict):
            continue
        if not all(k in theme for k in ("title", "problem_statement", "item_ids")):
            continue
        if not isinstance(theme["item_ids"], list):
            continue

        clean_ids = []
        for item_id in theme["item_ids"]:
            try:
                item_id = int(item_id)
            except (TypeError, ValueError):
                bad_ids.add(item_id)
                continue
            if item_id not in valid_ids:
                bad_ids.add(item_id)
                continue
            if item_id in seen_globally:
                # Duplicate across themes — skip silently (first theme wins)
                continue
            clean_ids.append(item_id)
            seen_globally.add(item_id)

        if clean_ids:
            cleaned.append({
                "title": str(theme["title"]).strip(),
                "problem_statement": str(theme["problem_statement"]).strip(),
                "item_ids": clean_ids,
            })

    return cleaned, bad_ids


def _compute_sources_breakdown(item_ids: list, items_by_id: dict) -> dict:
    """
    Given a list of item ids and a lookup dict of FeedbackItem objects,
    return a dict counting how many items came from each source.
    e.g. {"app_store": 9, "support": 5, "nps": 3}
    """
    breakdown = {}
    for item_id in item_ids:
        item = items_by_id.get(item_id)
        if item:
            breakdown[item.source] = breakdown.get(item.source, 0) + 1
    return breakdown


def run_theme_synthesis(app, run_id: int):
    """
    Stage 2: group all non-excluded FeedbackItems into themes using qwen-max.

    Sends {id, category, summary} for every item in one call.
    Validates that every returned item_id exists in this run's real item ids.
    Retries once with a corrective prompt if hallucinated ids are found.
    On second failure: drops bad ids, keeps valid ones, logs the event.
    Writes Theme rows and one AuditEvent.
    """
    _update_run(app, run_id, status="theming")

    # Load all non-excluded items for this run
    with app.app_context():
        items = (FeedbackItem.query
                 .filter_by(run_id=run_id, excluded=False)
                 .order_by(FeedbackItem.id)
                 .all())
        # Build a lookup dict we can use after the app context closes
        items_by_id = {item.id: item for item in items}

    if not items:
        _write_audit(app, run_id, "theme_synthesis", "skipped",
                     {"reason": "no items to theme"})
        return

    valid_ids = set(items_by_id.keys())

    # Build the payload — summaries are short, so the full list fits in one call
    payload = [
        {"id": item.id, "category": item.category, "summary": item.summary}
        for item in items
    ]

    messages = [
        {"role": "system", "content": THEME_PROMPT},
        {"role": "user", "content": json.dumps(payload)},
    ]

    # --- First attempt (with timeout retry) ---
    # qwen-max on large payloads occasionally times out even at 120s.
    # One silent retry saves the run in those cases.
    raw_response = None
    usage = {}
    for attempt in range(2):
        try:
            raw_response = _call_qwen(messages, THEME_MODEL,
                                      temperature=QWEN_MAX_TEMPERATURE)
            usage = _extract_usage(raw_response)
            break   # success — exit retry loop
        except requests.Timeout as e:
            if attempt == 0:
                logger.warning("Theme synthesis: timeout on attempt 1, retrying")
                _write_audit(app, run_id, "theme_synthesis", "timeout_retry",
                             {"attempt": 1, "error": str(e)})
            else:
                _write_audit(app, run_id, "theme_synthesis", "api_error",
                             {"error": str(e)})
                raise   # both attempts timed out — propagate to run_pipeline
        except requests.RequestException as e:
            _write_audit(app, run_id, "theme_synthesis", "api_error",
                         {"error": str(e)})
            raise   # non-timeout errors fail immediately

    reply_text = _extract_text(raw_response)

    # Parse the JSON — tolerant helper strips markdown fences if present
    try:
        parsed = _parse_json_reply(reply_text)
        if not isinstance(parsed, list):
            raise ValueError("Response is not a JSON array")
    except (json.JSONDecodeError, ValueError) as e:
        _write_audit(app, run_id, "theme_synthesis", "parse_error",
                     {"error": str(e), "raw_reply": reply_text},
                     model=THEME_MODEL, **usage)
        raise RuntimeError(f"Theme synthesis: could not parse model response: {e}")

    # Validate ids in the parsed response
    themes, bad_ids = _validate_theme_response(parsed, valid_ids)

    # --- Corrective retry if bad ids were found ---
    if bad_ids:
        logger.warning("Theme synthesis: hallucinated ids %s, retrying", bad_ids)
        _write_audit(app, run_id, "theme_synthesis", "hallucinated_ids_first_attempt", {
            "bad_ids": list(bad_ids),
            "valid_id_count": len(valid_ids),
        }, model=THEME_MODEL, **usage)

        retry_messages = messages + [
            {"role": "assistant", "content": reply_text},
            {"role": "user", "content": THEME_RETRY_PROMPT.format(
                bad_output=reply_text,
                valid_ids=", ".join(str(i) for i in sorted(valid_ids)),
                bad_ids=", ".join(str(i) for i in sorted(bad_ids)),
            )},
        ]

        try:
            raw_response = _call_qwen(retry_messages, THEME_MODEL,
                                      temperature=QWEN_MAX_TEMPERATURE)
            reply_text = _extract_text(raw_response)
            usage = _extract_usage(raw_response)
            parsed = _parse_json_reply(reply_text)
            themes, bad_ids = _validate_theme_response(parsed, valid_ids)
        except (requests.RequestException, json.JSONDecodeError) as e:
            _write_audit(app, run_id, "theme_synthesis", "retry_error",
                         {"error": str(e)},
                         model=THEME_MODEL, **usage)
            # Fall through — themes holds whatever valid results we have so far

        if bad_ids:
            # Second failure: log and continue with whatever valid ids survived
            _write_audit(app, run_id, "theme_synthesis", "hallucinated_ids_after_retry", {
                "bad_ids_dropped": list(bad_ids),
                "note": "Invalid ids removed; valid ids retained",
            }, model=THEME_MODEL, **usage)
            logger.error(
                "Theme synthesis run %d: still has bad ids after retry — "
                "dropped %d invalid ids, continuing with valid ones",
                run_id, len(bad_ids),
            )

    # --- Write Theme rows ---
    themes_created = 0
    # written_theme_dicts holds plain dicts (not ORM objects) so they survive
    # after the app_context closes. ORM objects become detached once the session
    # closes and cannot be read outside the context block.
    written_theme_dicts = []
    with app.app_context():
        for theme_data in themes:
            sources = _compute_sources_breakdown(theme_data["item_ids"], items_by_id)
            theme = Theme(
                run_id=run_id,
                title=theme_data["title"],
                problem_statement=theme_data["problem_statement"],
                item_ids=json.dumps(theme_data["item_ids"]),
                sources_breakdown=json.dumps(sources),
                # priority and rationale left empty — filled by Stage 3
            )
            db.session.add(theme)
            themes_created += 1

        db.session.commit()

        # Convert to plain dicts BEFORE the context closes so nothing outside
        # touches a detached ORM object.
        written_theme_dicts = [
            {
                "id": t.id,
                "title": t.title,
                "problem_statement": t.problem_statement,
                "item_ids": json.loads(t.item_ids or "[]"),
            }
            for t in Theme.query.filter_by(run_id=run_id).all()
        ]

        # Update the counts on the run
        run = db.session.get(PipelineRun, run_id)
        existing_counts = json.loads(run.counts_json) if run.counts_json else {}
        existing_counts["themes"] = themes_created
        run.counts_json = json.dumps(existing_counts)
        db.session.commit()

    _write_audit(app, run_id, "theme_synthesis", "themes_created", {
        "themes_created": themes_created,
        "items_input": len(items),
    }, model=THEME_MODEL,
       tokens_in=usage.get("tokens_in"),
       tokens_out=usage.get("tokens_out"))

    # --- Orphan recovery ---
    # Find any non-excluded items that didn't end up in any theme.
    # This can happen when hallucinated ids are dropped during validation.
    assigned_ids = set()
    for t in written_theme_dicts:
        assigned_ids.update(t["item_ids"])
    orphan_ids = valid_ids - assigned_ids

    if orphan_ids:
        logger.warning("Theme synthesis: %d orphaned items found, recovering", len(orphan_ids))
        _recover_orphans(app, run_id, orphan_ids, written_theme_dicts, items_by_id)

    # --- Coherence check + automatic retry ---
    # If any single theme holds >40% of items the model likely collapsed
    # unrelated problems into a catch-all bucket. Retry once with an explicit
    # warning that names the oversized theme and forbids it as a catch-all.
    total_items = len(valid_ids)
    oversized = [
        t for t in written_theme_dicts
        if total_items and len(t["item_ids"]) / total_items > 0.40
    ]
    if oversized:
        bad_theme = oversized[0]
        pct = round(len(bad_theme["item_ids"]) / total_items * 100, 1)
        logger.warning(
            "Theme coherence failure: '%s' holds %s%% of items — retrying synthesis",
            bad_theme["title"], pct,
        )
        _write_audit(app, run_id, "theme_synthesis", "theme_coherence_warning", {
            "theme_title": bad_theme["title"],
            "item_count": len(bad_theme["item_ids"]),
            "total_items": total_items,
            "pct": pct,
            "action": "retrying theme synthesis with stricter instructions",
        })

        # Build a corrective user message that names the problem explicitly
        coherence_warning = (
            f"IMPORTANT: in your previous attempt, a theme called "
            f"'{bad_theme['title']}' absorbed {pct}% of all items. "
            f"This is a catch-all collapse — unrelated problems were lumped together. "
            f"You MUST create between 7 and 12 distinct themes. "
            f"Do NOT create any theme that groups items with different root causes. "
            f"Separate app performance, login/OTP issues, transfer failures, "
            f"customer support, and fees into their own themes."
        )
        coherence_retry_messages = [
            {"role": "system", "content": THEME_PROMPT},
            {"role": "user", "content": coherence_warning + "\n\n" + json.dumps(payload)},
        ]

        try:
            retry_response = _call_qwen(coherence_retry_messages, THEME_MODEL,
                                        temperature=QWEN_MAX_TEMPERATURE)
            retry_text = _extract_text(retry_response)
            retry_usage = _extract_usage(retry_response)
            retry_parsed = _parse_json_reply(retry_text)
            retry_themes, retry_bad_ids = _validate_theme_response(retry_parsed, valid_ids)

            if retry_themes:
                # Replace the written themes with the better grouping
                with app.app_context():
                    # Delete the oversized theme set and rewrite
                    for old_t in Theme.query.filter_by(run_id=run_id).all():
                        db.session.delete(old_t)
                    db.session.commit()

                    for theme_data in retry_themes:
                        sources = _compute_sources_breakdown(theme_data["item_ids"],
                                                             items_by_id)
                        db.session.add(Theme(
                            run_id=run_id,
                            title=theme_data["title"],
                            problem_statement=theme_data["problem_statement"],
                            item_ids=json.dumps(theme_data["item_ids"]),
                            sources_breakdown=json.dumps(sources),
                        ))
                    db.session.commit()

                    # Refresh written_theme_dicts from the new rows
                    written_theme_dicts = [
                        {
                            "id": t.id,
                            "title": t.title,
                            "problem_statement": t.problem_statement,
                            "item_ids": json.loads(t.item_ids or "[]"),
                        }
                        for t in Theme.query.filter_by(run_id=run_id).all()
                    ]
                    # Update run counts
                    run = db.session.get(PipelineRun, run_id)
                    counts = json.loads(run.counts_json) if run.counts_json else {}
                    counts["themes"] = len(retry_themes)
                    run.counts_json = json.dumps(counts)
                    db.session.commit()

                _write_audit(app, run_id, "theme_synthesis", "coherence_retry_succeeded", {
                    "new_theme_count": len(retry_themes),
                    "previous_oversized_theme": bad_theme["title"],
                }, model=THEME_MODEL,
                   tokens_in=retry_usage.get("tokens_in"),
                   tokens_out=retry_usage.get("tokens_out"))
                logger.info("Coherence retry succeeded: %d themes", len(retry_themes))

        except (requests.RequestException, json.JSONDecodeError, ValueError) as e:
            # Retry failed — log it and continue with the original (imperfect) themes
            _write_audit(app, run_id, "theme_synthesis", "coherence_retry_failed", {
                "error": str(e),
                "note": "Keeping original themes despite coherence warning",
            })
            logger.error("Coherence retry failed: %s — keeping original themes", e)

    logger.info("Theme synthesis complete: %d themes from %d items", themes_created, len(items))


def _recover_orphans(app, run_id: int, orphan_ids: set,
                     theme_dicts: list, items_by_id: dict):
    """
    Assign orphaned items (those not in any theme) to existing themes via a
    targeted qwen-max call. Each orphan is assigned to exactly one existing theme.
    theme_dicts is a list of plain dicts {id, title, problem_statement, item_ids}
    — NOT ORM objects — so this function is safe to call outside an app_context.
    Updates the Theme rows in the DB and writes an audit event.
    Falls back to assigning orphans to the largest existing theme if the call fails.
    """
    orphan_items = [
        {
            "id": item_id,
            "category": items_by_id[item_id].category,
            "summary": items_by_id[item_id].summary,
        }
        for item_id in sorted(orphan_ids)
        if item_id in items_by_id
    ]
    existing_themes = [
        {"id": t["id"], "title": t["title"], "problem_statement": t["problem_statement"]}
        for t in theme_dicts
    ]

    valid_theme_ids = {t["id"] for t in theme_dicts}
    valid_orphan_ids = {item["id"] for item in orphan_items}

    messages = [
        {"role": "system", "content": THEME_ORPHAN_PROMPT.format(
            existing_themes=json.dumps(existing_themes, indent=2),
            orphan_items=json.dumps(orphan_items, indent=2),
        )},
        {"role": "user", "content": "Assign each unassigned item to its best existing theme."},
    ]

    assignments = []
    try:
        raw_response = _call_qwen(messages, THEME_MODEL,
                                  temperature=QWEN_MAX_TEMPERATURE)
        reply_text = _extract_text(raw_response)
        usage = _extract_usage(raw_response)
        parsed = _parse_json_reply(reply_text)

        # Validate: each entry must have item_id in orphan set, theme_id in existing set
        for entry in parsed:
            if not isinstance(entry, dict):
                continue
            item_id = entry.get("item_id")
            theme_id = entry.get("theme_id")
            try:
                item_id, theme_id = int(item_id), int(theme_id)
            except (TypeError, ValueError):
                continue
            if item_id in valid_orphan_ids and theme_id in valid_theme_ids:
                assignments.append((item_id, theme_id))

    except (requests.RequestException, json.JSONDecodeError, TypeError) as e:
        logger.error("Orphan recovery call failed: %s — falling back to largest theme", e)
        usage = {}
        # Fallback: assign all orphans to the theme with the most items
        largest = max(theme_dicts, key=lambda t: len(t["item_ids"]))
        assignments = [(oid, largest["id"]) for oid in orphan_ids if oid in items_by_id]

    if not assignments:
        # Nothing came back valid — use the fallback
        largest = max(theme_dicts, key=lambda t: len(t["item_ids"]))
        assignments = [(oid, largest["id"]) for oid in orphan_ids if oid in items_by_id]

    # Apply assignments: append each orphan id to its target theme's item_ids list
    with app.app_context():
        # Group assignments by theme_id for efficiency
        by_theme: dict[int, list] = {}
        for item_id, theme_id in assignments:
            by_theme.setdefault(theme_id, []).append(item_id)

        for theme_id, new_ids in by_theme.items():
            theme = db.session.get(Theme, theme_id)
            if theme is None:
                continue
            existing = json.loads(theme.item_ids or "[]")
            merged = existing + new_ids
            theme.item_ids = json.dumps(merged)
            # Recompute sources breakdown
            all_ids = merged
            sources = _compute_sources_breakdown(all_ids, items_by_id)
            theme.sources_breakdown = json.dumps(sources)

        db.session.commit()

    _write_audit(app, run_id, "theme_synthesis", "orphans_recovered", {
        "orphan_count": len(orphan_ids),
        "orphan_ids": list(orphan_ids),
        "assignments": [{"item_id": i, "theme_id": t} for i, t in assignments],
    }, model=THEME_MODEL,
       tokens_in=usage.get("tokens_in"),
       tokens_out=usage.get("tokens_out"))


# ---------------------------------------------------------------------------
# Stage 3: PRIORITIZATION
# ---------------------------------------------------------------------------

VALID_PRIORITIES = {"P1", "P2", "P3", "P4"}
DEFAULT_PRIORITY = "P3"   # safe fallback if validation fails after retry


def run_prioritization(app, run_id: int):
    """
    Stage 3: score each theme P1–P4 using qwen-max.

    Sends all themes for this run in one call (there are typically 8–12).
    Validates that every returned priority is exactly P1/P2/P3/P4 and that
    every rationale is a non-empty string.
    Retries once with a corrective prompt if any entry is invalid.
    On second failure for a theme: defaults to P3 and logs it.
    Writes priority and rationale back to each Theme row.
    """
    _update_run(app, run_id, status="prioritizing")

    # Load themes as plain dicts before the context closes.
    # Same pattern as run_theme_synthesis — ORM objects become detached once
    # the app_context block exits and cannot be read outside it.
    with app.app_context():
        theme_dicts = [
            {
                "id": t.id,
                "title": t.title,
                "problem_statement": t.problem_statement,
                "item_ids": json.loads(t.item_ids or "[]"),
                "sources_breakdown": json.loads(t.sources_breakdown or "{}"),
            }
            for t in Theme.query.filter_by(run_id=run_id).order_by(Theme.id).all()
        ]

    valid_theme_ids = {t["id"] for t in theme_dicts}

    if not theme_dicts:
        _write_audit(app, run_id, "prioritization", "skipped",
                     {"reason": "no themes to prioritize"})
        return

    # Build payload — evidence_count derived from item_ids length
    payload = [
        {
            "id": t["id"],
            "title": t["title"],
            "problem_statement": t["problem_statement"],
            "evidence_count": len(t["item_ids"]),
            "sources_breakdown": t["sources_breakdown"],
        }
        for t in theme_dicts
    ]

    messages = [
        {"role": "system", "content": PRIORITY_PROMPT},
        {"role": "user", "content": json.dumps(payload)},
    ]

    # --- First attempt (with timeout retry) ---
    raw_response = None
    usage = {}
    for attempt in range(2):
        try:
            raw_response = _call_qwen(messages, THEME_MODEL,
                                      temperature=QWEN_MAX_TEMPERATURE)
            usage = _extract_usage(raw_response)
            break
        except requests.Timeout as e:
            if attempt == 0:
                logger.warning("Prioritization: timeout on attempt 1, retrying")
                _write_audit(app, run_id, "prioritization", "timeout_retry",
                             {"attempt": 1, "error": str(e)})
            else:
                _write_audit(app, run_id, "prioritization", "api_error", {"error": str(e)})
                raise
        except requests.RequestException as e:
            _write_audit(app, run_id, "prioritization", "api_error", {"error": str(e)})
            raise

    reply_text = _extract_text(raw_response)

    try:
        parsed = _parse_json_reply(reply_text)
        if not isinstance(parsed, list):
            raise ValueError("Response is not a JSON array")
    except (json.JSONDecodeError, ValueError) as e:
        _write_audit(app, run_id, "prioritization", "parse_error",
                     {"error": str(e), "raw_reply": reply_text},
                     model=THEME_MODEL, **usage)
        raise RuntimeError(f"Prioritization: could not parse model response: {e}")

    # Validate each entry
    results, bad_entries = _validate_priority_response(parsed, valid_theme_ids)

    # --- Corrective retry if anything was invalid ---
    if bad_entries:
        logger.warning("Prioritization: invalid entries %s, retrying", bad_entries)
        bad_desc = "; ".join(
            f"theme id {e['id']}: priority='{e.get('priority', 'missing')}'"
            for e in bad_entries
        )
        retry_messages = messages + [
            {"role": "assistant", "content": reply_text},
            {"role": "user", "content": PRIORITY_RETRY_PROMPT.format(
                bad_output=reply_text,
                bad_entries=bad_desc,
            )},
        ]
        try:
            raw_response = _call_qwen(retry_messages, THEME_MODEL,
                                      temperature=QWEN_MAX_TEMPERATURE)
            reply_text = _extract_text(raw_response)
            usage = _extract_usage(raw_response)
            parsed = _parse_json_reply(reply_text)
            results, bad_entries = _validate_priority_response(parsed, valid_theme_ids)
        except (requests.RequestException, json.JSONDecodeError) as e:
            _write_audit(app, run_id, "prioritization", "retry_error",
                         {"error": str(e)}, model=THEME_MODEL, **usage)
            # Fall through — results holds whatever was valid

        # Anything still invalid after retry gets defaulted to P3
        if bad_entries:
            defaulted_ids = [e["id"] for e in bad_entries if "id" in e]
            for theme_id in defaulted_ids:
                if theme_id in valid_theme_ids:
                    results.append({
                        "id": theme_id,
                        "priority": DEFAULT_PRIORITY,
                        "rationale": "Priority could not be determined; defaulted to P3.",
                    })
            _write_audit(app, run_id, "prioritization", "defaulted_to_p3", {
                "theme_ids": defaulted_ids,
                "reason": "Invalid priority value after retry",
            }, model=THEME_MODEL, **usage)
            logger.error(
                "Prioritization run %d: defaulted %d theme(s) to P3 after retry failure",
                run_id, len(defaulted_ids),
            )

    # --- Write priority and rationale back to Theme rows ---
    with app.app_context():
        for entry in results:
            theme = db.session.get(Theme, entry["id"])
            if theme is None:
                continue
            theme.priority = entry["priority"]
            theme.rationale = entry["rationale"]
        db.session.commit()

    _write_audit(app, run_id, "prioritization", "prioritization_complete", {
        "themes_scored": len(results),
        "priority_breakdown": _count_priorities(results),
    }, model=THEME_MODEL,
       tokens_in=usage.get("tokens_in"),
       tokens_out=usage.get("tokens_out"))

    logger.info(
        "Prioritization complete: %s",
        _count_priorities(results),
    )


def _validate_priority_response(parsed: list, valid_theme_ids: set) -> tuple[list, list]:
    """
    Check a parsed prioritization response.
    Returns (valid_results, bad_entries) where:
      - valid_results: list of dicts that passed all checks
      - bad_entries:   list of dicts that failed (missing keys, bad priority, empty rationale)
    """
    valid = []
    bad = []
    seen_ids = set()

    for entry in parsed:
        if not isinstance(entry, dict):
            bad.append(entry)
            continue

        theme_id = entry.get("id")
        priority = entry.get("priority", "")
        rationale = entry.get("rationale", "")

        try:
            theme_id = int(theme_id)
        except (TypeError, ValueError):
            bad.append(entry)
            continue

        if theme_id not in valid_theme_ids:
            bad.append(entry)
            continue
        if theme_id in seen_ids:
            continue   # duplicate — silently skip, first entry wins
        if priority not in VALID_PRIORITIES:
            bad.append(entry)
            continue
        if not isinstance(rationale, str) or not rationale.strip():
            bad.append(entry)
            continue

        seen_ids.add(theme_id)
        valid.append({"id": theme_id, "priority": priority, "rationale": rationale.strip()})

    return valid, bad


def _count_priorities(results: list) -> dict:
    """Return a count of how many themes landed at each priority level."""
    counts = {"P1": 0, "P2": 0, "P3": 0, "P4": 0}
    for r in results:
        p = r.get("priority")
        if p in counts:
            counts[p] += 1
    return counts


# ---------------------------------------------------------------------------
# Stage 4: TICKET DRAFTING
# ---------------------------------------------------------------------------

VALID_SEVERITIES = {"critical", "high", "medium", "low"}
TICKET_EVIDENCE_SAMPLES = 5   # verbatim feedback items to include per theme


def run_ticket_drafting(app, run_id: int):
    """
    Stage 4: draft sprint-ready tickets for all P1 and P2 themes.

    Sends each qualifying theme with its title, problem_statement, priority,
    rationale, evidence_count, and up to TICKET_EVIDENCE_SAMPLES verbatim
    feedback items to qwen-max.

    Validates the response (theme_id, title, user_story, acceptance_criteria,
    severity). Retries once on validation failure. On second failure for a
    theme: skips it and logs — bad tickets are never written.

    Writes DraftTicket rows with status=pending_review and one AuditEvent.
    """
    _update_run(app, run_id, status="drafting")

    # Load P1 and P2 themes as plain dicts — same session-safety pattern
    with app.app_context():
        qualifying = (Theme.query
                      .filter_by(run_id=run_id)
                      .filter(Theme.priority.in_(["P1", "P2"]))
                      .order_by(Theme.priority, Theme.id)
                      .all())
        if not qualifying:
            _write_audit(app, run_id, "ticket_drafting", "skipped",
                         {"reason": "no P1 or P2 themes found"})
            return

        # Fetch evidence samples for each theme inside the same context
        theme_dicts = []
        for t in qualifying:
            item_ids = json.loads(t.item_ids or "[]")
            sample_ids = item_ids[:TICKET_EVIDENCE_SAMPLES]
            samples = (FeedbackItem.query
                       .filter(FeedbackItem.id.in_(sample_ids))
                       .all())
            theme_dicts.append({
                "theme_id": t.id,
                "title": t.title,
                "priority": t.priority,
                "rationale": t.rationale,
                "evidence_count": len(item_ids),
                "evidence_samples": [
                    {"text": item.text, "category": item.category}
                    for item in samples
                ],
            })

    valid_theme_ids = {t["theme_id"] for t in theme_dicts}

    messages = [
        {"role": "system", "content": TICKET_PROMPT},
        {"role": "user", "content": json.dumps(theme_dicts)},
    ]

    # --- First attempt (with timeout retry) ---
    raw_response = None
    usage = {}
    for attempt in range(2):
        try:
            raw_response = _call_qwen(messages, THEME_MODEL,
                                      temperature=QWEN_MAX_TEMPERATURE)
            usage = _extract_usage(raw_response)
            break
        except requests.Timeout as e:
            if attempt == 0:
                logger.warning("Ticket drafting: timeout on attempt 1, retrying")
                _write_audit(app, run_id, "ticket_drafting", "timeout_retry",
                             {"attempt": 1, "error": str(e)})
            else:
                _write_audit(app, run_id, "ticket_drafting", "api_error",
                             {"error": str(e)})
                raise
        except requests.RequestException as e:
            _write_audit(app, run_id, "ticket_drafting", "api_error",
                         {"error": str(e)})
            raise

    reply_text = _extract_text(raw_response)

    # Parse — tolerant helper strips markdown fences
    try:
        parsed = _parse_json_reply(reply_text)
        if not isinstance(parsed, list):
            raise ValueError("Response is not a JSON array")
    except (json.JSONDecodeError, ValueError) as e:
        _write_audit(app, run_id, "ticket_drafting", "parse_error",
                     {"error": str(e), "raw_reply": reply_text[:500]},
                     model=THEME_MODEL, **usage)
        raise RuntimeError(f"Ticket drafting: could not parse model response: {e}")

    # Validate
    tickets, bad_theme_ids = _validate_ticket_response(parsed, valid_theme_ids)

    # --- Corrective retry if any tickets were invalid ---
    if bad_theme_ids:
        logger.warning("Ticket drafting: invalid tickets for theme_ids %s, retrying",
                       bad_theme_ids)
        retry_messages = messages + [
            {"role": "assistant", "content": reply_text},
            {"role": "user", "content": TICKET_RETRY_PROMPT.format(
                bad_output=reply_text,
                bad_theme_ids=", ".join(str(i) for i in sorted(bad_theme_ids)),
            )},
        ]
        try:
            retry_response = _call_qwen(retry_messages, THEME_MODEL,
                                        temperature=QWEN_MAX_TEMPERATURE)
            retry_text = _extract_text(retry_response)
            usage = _extract_usage(retry_response)
            retry_parsed = _parse_json_reply(retry_text)
            tickets, bad_theme_ids = _validate_ticket_response(retry_parsed,
                                                                valid_theme_ids)
        except (requests.RequestException, json.JSONDecodeError) as e:
            _write_audit(app, run_id, "ticket_drafting", "retry_error",
                         {"error": str(e)}, model=THEME_MODEL, **usage)
            # Fall through — tickets holds whatever was valid from first pass

        if bad_theme_ids:
            # Still invalid after retry — skip those themes, don't write bad tickets
            _write_audit(app, run_id, "ticket_drafting", "tickets_skipped", {
                "skipped_theme_ids": list(bad_theme_ids),
                "reason": "Failed validation after retry — ticket not written",
            }, model=THEME_MODEL, **usage)
            logger.error(
                "Ticket drafting run %d: skipped %d theme(s) after retry failure",
                run_id, len(bad_theme_ids),
            )

    # --- Write DraftTicket rows ---
    tickets_created = 0
    with app.app_context():
        for ticket in tickets:
            draft = DraftTicket(
                theme_id=ticket["theme_id"],
                title=ticket["title"],
                user_story=ticket["user_story"],
                acceptance_criteria=json.dumps(ticket["acceptance_criteria"]),
                severity=ticket["severity"],
                status="pending_review",
                edited_by_human=False,
            )
            db.session.add(draft)
            tickets_created += 1

        # Update run counts
        run = db.session.get(PipelineRun, run_id)
        counts = json.loads(run.counts_json) if run.counts_json else {}
        counts["tickets"] = tickets_created
        run.counts_json = json.dumps(counts)
        db.session.commit()

    _write_audit(app, run_id, "ticket_drafting", "tickets_created", {
        "tickets_created": tickets_created,
        "themes_input": len(theme_dicts),
    }, model=THEME_MODEL,
       tokens_in=usage.get("tokens_in"),
       tokens_out=usage.get("tokens_out"))

    logger.info("Ticket drafting complete: %d tickets from %d themes",
                tickets_created, len(theme_dicts))


def _validate_ticket_response(parsed: list,
                               valid_theme_ids: set) -> tuple[list, set]:
    """
    Validate a parsed ticket drafting response.
    Returns (valid_tickets, bad_theme_ids) where:
      - valid_tickets:  list of dicts that passed all checks
      - bad_theme_ids:  set of theme_ids whose tickets failed validation
    """
    valid = []
    bad = set()
    seen = set()

    for entry in parsed:
        if not isinstance(entry, dict):
            continue

        try:
            theme_id = int(entry.get("theme_id"))
        except (TypeError, ValueError):
            continue

        if theme_id not in valid_theme_ids:
            continue
        if theme_id in seen:
            continue   # duplicate — first wins

        title = entry.get("title", "")
        user_story = entry.get("user_story", "")
        criteria = entry.get("acceptance_criteria", [])
        severity = entry.get("severity", "")

        if not isinstance(title, str) or not title.strip():
            bad.add(theme_id); continue
        if not isinstance(user_story, str) or "I want" not in user_story:
            bad.add(theme_id); continue
        if not isinstance(criteria, list) or not (3 <= len(criteria) <= 5):
            bad.add(theme_id); continue
        if any(not isinstance(c, str) or not c.strip() for c in criteria):
            bad.add(theme_id); continue
        if severity not in VALID_SEVERITIES:
            bad.add(theme_id); continue

        seen.add(theme_id)
        valid.append({
            "theme_id": theme_id,
            "title": title.strip(),
            "user_story": user_story.strip(),
            "acceptance_criteria": [c.strip() for c in criteria],
            "severity": severity,
        })

    return valid, bad


# ---------------------------------------------------------------------------
# Top-level: run the full pipeline (Stages 0–4)
# ---------------------------------------------------------------------------

def run_pipeline(app, run_id: int, filepath: str):
    """
    Entry point called by app.py in a background thread.
    Runs Stages 0–4 in sequence.
    Sets run status to awaiting_review on success, failed on error.
    """
    try:
        run_ingest(app, run_id, filepath)
        run_triage(app, run_id)
        run_theme_synthesis(app, run_id)
        run_prioritization(app, run_id)
        run_ticket_drafting(app, run_id)
        _update_run(app, run_id,
                    status="awaiting_review",
                    finished_at=datetime.now(timezone.utc))
    except Exception as e:
        logger.exception("Pipeline failed for run %d", run_id)
        _update_run(app, run_id,
                    status="failed",
                    finished_at=datetime.now(timezone.utc))
        _write_audit(app, run_id, "pipeline", "pipeline_failed", {"error": str(e)})
