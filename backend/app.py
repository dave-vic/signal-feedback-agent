"""
Signal — Backend
================
Flask app: routing and request/response only.
All pipeline logic lives in pipeline.py.
"""

import os
import json
import tempfile
import threading
import requests
from flask import Flask, request, jsonify

from models import db, PipelineRun, FeedbackItem, Theme, DraftTicket
from prompts import TRIAGE_PROMPT
from pipeline import run_pipeline

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Database configuration
# ---------------------------------------------------------------------------
# SQLite stores everything in a single file next to app.py during local dev.
# To switch to Alibaba RDS later, replace this URL with the MySQL connection
# string — none of the model code in models.py needs to change.
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///signal.db"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False  # silences a noisy warning

db.init_app(app)

# Create all tables on startup if they don't already exist.
# This is safe to call every time — SQLAlchemy skips tables that are already there.
with app.app_context():
    db.create_all()

    # Startup recovery: if the server was killed mid-pipeline, any run still in
    # an in-progress status will never advance. Mark them failed immediately so
    # the frontend doesn't show a spinner forever.
    IN_PROGRESS_STATUSES = ("ingesting", "triaging", "theming", "prioritizing", "drafting")
    from datetime import datetime, timezone
    from models import AuditEvent

    stuck_runs = PipelineRun.query.filter(PipelineRun.status.in_(IN_PROGRESS_STATUSES)).all()
    for run in stuck_runs:
        previous_status = run.status   # capture before overwriting
        run.status = "failed"
        run.finished_at = datetime.now(timezone.utc)
        db.session.add(AuditEvent(
            run_id=run.id,
            stage="pipeline",
            action="pipeline_failed",
            detail_json=json.dumps({
                "error": f"Server restarted while run was in status '{previous_status}'. "
                         "Pipeline did not complete."
            }),
        ))
    if stuck_runs:
        db.session.commit()
        import logging
        logging.getLogger(__name__).warning(
            "Marked %d stuck run(s) as failed on startup: %s",
            len(stuck_runs), [r.id for r in stuck_runs]
        )

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
# The API key is read from an environment variable — NEVER written in code.
# Locally: set it in your terminal before running (see README).
# On Alibaba: set it in the Function Compute console under Environment Variables.
API_KEY = os.environ.get("DASHSCOPE_API_KEY")

# Model Studio exposes an OpenAI-compatible endpoint, which means the request
# format is the industry standard — skills learned here transfer everywhere.
# NOTE: this is the INTERNATIONAL endpoint. If your Alibaba account is on the
# China (Beijing) region, swap to: https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"

# TRIAGE_PROMPT is now imported from prompts.py (see above).


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.route("/", methods=["GET"])
def health():
    """A 'is this thing on?' check. Visiting the URL in a browser hits this."""
    return jsonify({"status": "ok", "service": "signal-hello-world"})


@app.route("/classify", methods=["POST"])
def classify():
    """
    Accepts: POST with JSON body  {"text": "some feedback item"}
    Returns: Qwen's classification as JSON.
    """
    # --- 1. Validate the input -------------------------------------------
    body = request.get_json(silent=True)
    if not body or "text" not in body:
        return jsonify({"error": "Send JSON like {\"text\": \"...\"}"}), 400

    if not API_KEY:
        return jsonify({"error": "DASHSCOPE_API_KEY env variable is not set"}), 500

    # --- 2. Call Qwen ------------------------------------------------------
    payload = {
        "model": "qwen-turbo",
        "messages": [
            {"role": "system", "content": TRIAGE_PROMPT},
            {"role": "user", "content": body["text"]},
        ],
    }
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    }

    try:
        resp = requests.post(QWEN_URL, json=payload, headers=headers, timeout=30)
        resp.raise_for_status()  # raises an error for 4xx/5xx responses
    except requests.RequestException as e:
        # Surfacing the real error message makes debugging 10x easier.
        return jsonify({"error": "Qwen API call failed", "detail": str(e)}), 502

    # --- 3. Extract the model's reply --------------------------------------
    data = resp.json()
    reply_text = data["choices"][0]["message"]["content"]

    # The model was told to return pure JSON — but models occasionally
    # disobey, so we parse defensively. (Lesson one of agent engineering:
    # never blindly trust model output.)
    try:
        classification = json.loads(reply_text)
    except json.JSONDecodeError:
        classification = {"raw_reply": reply_text, "note": "Model did not return clean JSON"}

    # --- 4. Return the result ----------------------------------------------
    return jsonify({
        "input": body["text"],
        "classification": classification,
        "tokens_used": data.get("usage", {}),  # free observability
    })


# ---------------------------------------------------------------------------
# Pipeline endpoints
# ---------------------------------------------------------------------------

@app.route("/runs", methods=["POST"])
def create_run():
    """
    Accepts: multipart/form-data with a 'file' field containing a CSV.
    Creates a PipelineRun, saves the CSV to a temp file, starts the pipeline
    in a background thread, and returns the run_id immediately so the caller
    can poll GET /runs/<id> for progress.
    """
    if "file" not in request.files:
        return jsonify({"error": "No file field in request"}), 400

    uploaded = request.files["file"]
    if not uploaded.filename:
        return jsonify({"error": "Empty filename"}), 400

    # Save the uploaded file to a temp path that the background thread can read.
    # NamedTemporaryFile with delete=False gives us a real path on disk.
    suffix = os.path.splitext(uploaded.filename)[1] or ".csv"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    uploaded.save(tmp.name)

    # Create the PipelineRun row now so we have an ID to return immediately.
    with app.app_context():
        run = PipelineRun(filename=uploaded.filename, status="ingesting")
        db.session.add(run)
        db.session.commit()
        run_id = run.id

    # Start the pipeline in a background thread.
    # We pass `app` explicitly because threads don't inherit Flask's context.
    thread = threading.Thread(
        target=run_pipeline,
        args=(app, run_id, tmp.name),
        daemon=True,
    )
    thread.start()

    return jsonify({"run_id": run_id, "status": "ingesting"}), 202


@app.route("/runs/<int:run_id>", methods=["GET"])
def get_run(run_id):
    """
    Returns the current status and counts for a pipeline run.
    The frontend polls this endpoint to display progress.
    """
    with app.app_context():
        run = db.session.get(PipelineRun, run_id)

    if run is None:
        return jsonify({"error": "Run not found"}), 404

    counts = json.loads(run.counts_json) if run.counts_json else {}

    return jsonify({
        "run_id": run.id,
        "filename": run.filename,
        "status": run.status,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
        "counts": counts,
    })


# ---------------------------------------------------------------------------
# Theme endpoints
# ---------------------------------------------------------------------------

@app.route("/runs/<int:run_id>/themes", methods=["GET"])
def get_themes(run_id):
    """
    Returns all themes for a run: title, problem_statement, evidence count,
    sources breakdown. Sorted by number of items descending (most evidence first)
    until Stage 3 adds priority scores.
    """
    with app.app_context():
        run = db.session.get(PipelineRun, run_id)
        if run is None:
            return jsonify({"error": "Run not found"}), 404

        themes = (Theme.query
                  .filter_by(run_id=run_id)
                  .order_by(Theme.id)
                  .all())

    result = []
    for t in themes:
        item_ids = json.loads(t.item_ids) if t.item_ids else []
        sources = json.loads(t.sources_breakdown) if t.sources_breakdown else {}
        result.append({
            "id": t.id,
            "title": t.title,
            "problem_statement": t.problem_statement,
            "priority": t.priority,
            "rationale": t.rationale,
            "evidence_count": len(item_ids),
            "sources_breakdown": sources,
        })

    # Sort by priority (P1 first), then by evidence count within each band.
    # Themes with no priority yet (null) go last.
    priority_order = {"P1": 0, "P2": 1, "P3": 2, "P4": 3}
    result.sort(key=lambda t: (
        priority_order.get(t["priority"], 99),
        -t["evidence_count"],
    ))

    return jsonify({"run_id": run_id, "themes": result})


@app.route("/runs/<int:run_id>/tickets", methods=["GET"])
def get_tickets(run_id):
    """
    Returns all draft tickets for a run.
    Each ticket includes its theme_id, title, user_story,
    acceptance_criteria (parsed from JSON), severity, and status.
    Only tickets with status pending_review are shown by default.
    Pass ?all=true to include approved and rejected tickets too.
    """
    with app.app_context():
        run = db.session.get(PipelineRun, run_id)
        if run is None:
            return jsonify({"error": "Run not found"}), 404

        show_all = request.args.get("all", "").lower() == "true"

        tickets_query = (DraftTicket.query
                         .join(Theme, DraftTicket.theme_id == Theme.id)
                         .filter(Theme.run_id == run_id)
                         .order_by(DraftTicket.id))

        if not show_all:
            tickets_query = tickets_query.filter(
                DraftTicket.status == "pending_review"
            )

        tickets = tickets_query.all()
        payload = [
            {
                "id": t.id,
                "theme_id": t.theme_id,
                "title": t.title,
                "user_story": t.user_story,
                "acceptance_criteria": json.loads(t.acceptance_criteria)
                    if t.acceptance_criteria else [],
                "severity": t.severity,
                "status": t.status,
                "edited_by_human": t.edited_by_human,
                "external_ref": t.external_ref,
            }
            for t in tickets
        ]

    return jsonify({"run_id": run_id, "tickets": payload})


@app.route("/themes/<int:theme_id>", methods=["GET"])
def get_theme(theme_id):
    """
    Returns one theme plus its full evidence chain: every underlying
    FeedbackItem's original text, category, and summary.
    Also includes any draft tickets linked to this theme.
    This is the 'show me why' screen — the trust argument.
    """
    with app.app_context():
        theme = db.session.get(Theme, theme_id)
        if theme is None:
            return jsonify({"error": "Theme not found"}), 404

        item_ids = json.loads(theme.item_ids) if theme.item_ids else []
        sources = json.loads(theme.sources_breakdown) if theme.sources_breakdown else {}

        # Fetch the actual FeedbackItem rows in one query
        items = (FeedbackItem.query
                 .filter(FeedbackItem.id.in_(item_ids))
                 .order_by(FeedbackItem.id)
                 .all())
        items_payload = [
            {
                "id": item.id,
                "source": item.source,
                "text": item.text,
                "category": item.category,
                "summary": item.summary,
                "confidence": item.confidence,
            }
            for item in items
        ]

        # Fetch any draft tickets for this theme
        tickets = (DraftTicket.query
                   .filter_by(theme_id=theme_id)
                   .order_by(DraftTicket.id)
                   .all())
        tickets_payload = [
            {
                "id": t.id,
                "title": t.title,
                "user_story": t.user_story,
                "acceptance_criteria": json.loads(t.acceptance_criteria)
                    if t.acceptance_criteria else [],
                "severity": t.severity,
                "status": t.status,
                "edited_by_human": t.edited_by_human,
            }
            for t in tickets
        ]

    return jsonify({
        "id": theme.id,
        "run_id": theme.run_id,
        "title": theme.title,
        "problem_statement": theme.problem_statement,
        "priority": theme.priority,
        "rationale": theme.rationale,
        "sources_breakdown": sources,
        "evidence_count": len(item_ids),
        "items": items_payload,
        "tickets": tickets_payload,
    })


# ---------------------------------------------------------------------------
# Ticket action endpoints — human-in-the-loop
# ---------------------------------------------------------------------------

@app.route("/tickets/<int:ticket_id>", methods=["PATCH"])
def edit_ticket(ticket_id):
    """
    Edit one or more fields of a draft ticket before approving.
    Accepted fields in the JSON body: title, user_story,
    acceptance_criteria (list of strings), severity.
    Sets edited_by_human=True and writes an AuditEvent recording
    exactly which fields changed and their old vs new values.
    """
    from datetime import datetime, timezone
    from models import AuditEvent

    body = request.get_json(silent=True) or {}
    EDITABLE = {"title", "user_story", "acceptance_criteria", "severity"}
    updates  = {k: v for k, v in body.items() if k in EDITABLE}

    if not updates:
        return jsonify({"error": "No editable fields provided"}), 400

    with app.app_context():
        ticket = db.session.get(DraftTicket, ticket_id)
        if ticket is None:
            return jsonify({"error": "Ticket not found"}), 404

        # Record old values for the audit trail
        diff = {}
        for field, new_val in updates.items():
            if field == "acceptance_criteria":
                old_val = json.loads(ticket.acceptance_criteria) \
                    if ticket.acceptance_criteria else []
                ticket.acceptance_criteria = json.dumps(new_val)
            else:
                old_val = getattr(ticket, field)
                setattr(ticket, field, new_val)
            diff[field] = {"old": old_val, "new": new_val}

        ticket.edited_by_human = True

        # Resolve run_id via the parent theme so AuditEvent has it
        theme  = db.session.get(Theme, ticket.theme_id)
        run_id = theme.run_id if theme else None

        db.session.add(AuditEvent(
            run_id=run_id,
            stage="human",
            action="ticket_edited",
            detail_json=json.dumps({
                "ticket_id": ticket_id,
                "changes": diff,
            }),
        ))
        db.session.commit()

        return jsonify({
            "id":                ticket.id,
            "title":             ticket.title,
            "user_story":        ticket.user_story,
            "acceptance_criteria": json.loads(ticket.acceptance_criteria)
                if ticket.acceptance_criteria else [],
            "severity":          ticket.severity,
            "status":            ticket.status,
            "edited_by_human":   ticket.edited_by_human,
        })


@app.route("/tickets/<int:ticket_id>/approve", methods=["POST"])
def approve_ticket(ticket_id):
    """
    Mark a draft ticket as approved.
    This only updates status locally — nothing is sent anywhere automatically.
    Writes an AuditEvent tagged stage="human", action="ticket_approved".
    """
    from datetime import datetime, timezone
    from models import AuditEvent

    with app.app_context():
        ticket = db.session.get(DraftTicket, ticket_id)
        if ticket is None:
            return jsonify({"error": "Ticket not found"}), 404

        if ticket.status == "approved":
            return jsonify({"error": "Ticket is already approved"}), 409

        previous_status  = ticket.status
        ticket.status    = "approved"

        theme  = db.session.get(Theme, ticket.theme_id)
        run_id = theme.run_id if theme else None

        db.session.add(AuditEvent(
            run_id=run_id,
            stage="human",
            action="ticket_approved",
            detail_json=json.dumps({
                "ticket_id":      ticket_id,
                "title":          ticket.title,
                "previous_status": previous_status,
                "edited_by_human": ticket.edited_by_human,
            }),
        ))
        db.session.commit()

    return jsonify({"id": ticket_id, "status": "approved"})


@app.route("/tickets/<int:ticket_id>/reject", methods=["POST"])
def reject_ticket(ticket_id):
    """
    Mark a draft ticket as rejected.
    Accepts an optional JSON body: {"reason": "duplicate of PROJ-12"}.
    Writes an AuditEvent tagged stage="human", action="ticket_rejected".
    """
    from datetime import datetime, timezone
    from models import AuditEvent

    body   = request.get_json(silent=True) or {}
    reason = body.get("reason", "")

    with app.app_context():
        ticket = db.session.get(DraftTicket, ticket_id)
        if ticket is None:
            return jsonify({"error": "Ticket not found"}), 404

        if ticket.status == "rejected":
            return jsonify({"error": "Ticket is already rejected"}), 409

        previous_status = ticket.status
        ticket.status   = "rejected"

        theme  = db.session.get(Theme, ticket.theme_id)
        run_id = theme.run_id if theme else None

        db.session.add(AuditEvent(
            run_id=run_id,
            stage="human",
            action="ticket_rejected",
            detail_json=json.dumps({
                "ticket_id":       ticket_id,
                "title":           ticket.title,
                "previous_status": previous_status,
                "reason":          reason,
            }),
        ))
        db.session.commit()

    return jsonify({"id": ticket_id, "status": "rejected"})


# ---------------------------------------------------------------------------
# Local development entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    # Runs the app on http://localhost:9000 when you execute: python app.py
    # Port 9000 matches Function Compute's default web-function port,
    # so the same file works in both places unchanged.
    app.run(host="0.0.0.0", port=9000, debug=True)
