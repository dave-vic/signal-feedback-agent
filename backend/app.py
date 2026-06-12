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

from models import db, PipelineRun, FeedbackItem
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
# Local development entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    # Runs the app on http://localhost:9000 when you execute: python app.py
    # Port 9000 matches Function Compute's default web-function port,
    # so the same file works in both places unchanged.
    app.run(host="0.0.0.0", port=9000, debug=True)
