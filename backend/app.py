"""
Signal — Hello World backend
=============================
The smallest possible version of Signal's brain:
receive text -> send it to Qwen -> return the reply.

Run it locally first, then deploy the same file to Alibaba Function Compute.
Every line is commented because reading and understanding this file IS the exercise.
"""

import os
import json
import requests
from flask import Flask, request, jsonify

app = Flask(__name__)

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

# The exact prompt that worked in the playground, now living in code.
SYSTEM_PROMPT = (
    "You are a product feedback triage system. Classify the feedback item into "
    "exactly one of: bug_report, feature_request, complaint, praise, noise. "
    "Detect sarcasm and classify by the true underlying sentiment. "
    "Respond ONLY with a JSON object with keys: category, summary, confidence. "
    "No other text, no markdown."
)


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
            {"role": "system", "content": SYSTEM_PROMPT},
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
# Local development entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    # Runs the app on http://localhost:9000 when you execute: python app.py
    # Port 9000 matches Function Compute's default web-function port,
    # so the same file works in both places unchanged.
    app.run(host="0.0.0.0", port=9000, debug=True)
