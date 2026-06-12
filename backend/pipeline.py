"""
Signal — Agent pipeline (Stages 0 and 1)
=========================================
Stage 0: INGEST   — parse CSV into FeedbackItem rows
Stage 1: TRIAGE   — classify items with qwen-turbo, mark exclusions, audit everything

This module has no Flask imports. It's pure Python that talks to the database
and the Qwen API. app.py calls run_pipeline() in a background thread.
"""

import os
import csv
import json
import logging
import requests
from datetime import datetime, timezone

from models import db, PipelineRun, FeedbackItem, AuditEvent
from prompts import TRIAGE_PROMPT, TRIAGE_RETRY_PROMPT

logger = logging.getLogger(__name__)

# Qwen endpoint and model choices — match ARCHITECTURE.md
QWEN_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"
TRIAGE_MODEL = "qwen-turbo"

BATCH_SIZE = 10   # items per Qwen call during triage
VALID_CATEGORIES = {"bug_report", "feature_request", "complaint", "praise", "noise"}


# ---------------------------------------------------------------------------
# Qwen API helper
# ---------------------------------------------------------------------------

def _call_qwen(messages: list, model: str) -> dict:
    """
    Send a messages list to Qwen and return the raw response dict.
    Raises requests.RequestException on network/HTTP errors.
    The caller is responsible for parsing and validating the content.
    """
    api_key = os.environ.get("DASHSCOPE_API_KEY")
    if not api_key:
        raise RuntimeError("DASHSCOPE_API_KEY environment variable is not set")

    resp = requests.post(
        QWEN_URL,
        json={"model": model, "messages": messages},
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        timeout=60,
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
# Top-level: run the full pipeline (Stages 0 + 1)
# ---------------------------------------------------------------------------

def run_pipeline(app, run_id: int, filepath: str):
    """
    Entry point called by app.py in a background thread.
    Runs Stage 0 (ingest) then Stage 1 (triage).
    Sets run status to awaiting_review on success, failed on error.
    """
    try:
        run_ingest(app, run_id, filepath)
        run_triage(app, run_id)
        _update_run(app, run_id,
                    status="awaiting_review",
                    finished_at=datetime.now(timezone.utc))
    except Exception as e:
        logger.exception("Pipeline failed for run %d", run_id)
        _update_run(app, run_id,
                    status="failed",
                    finished_at=datetime.now(timezone.utc))
        _write_audit(app, run_id, "pipeline", "pipeline_failed", {"error": str(e)})
