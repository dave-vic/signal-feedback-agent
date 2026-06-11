# Signal — Hello World: Run & Deploy Guide

Goal: see Qwen answer from YOUR deployed Alibaba endpoint, and record it.
Do Part A (local) before Part B (cloud) — if it works locally, any cloud
problem is a deployment problem, not a code problem. That distinction
saves hours of confused debugging.

---

## Part A — Run it locally (15–20 min)

1. Put `app.py` and `requirements.txt` in a folder called `backend/` inside
   your repo.

2. Open a terminal in that folder and create a virtual environment
   (an isolated bubble for this project's Python packages):

   **Mac:**
   ```
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   ```

   **Windows:**
   ```
   python -m venv venv
   venv\Scripts\activate
   pip install -r requirements.txt
   ```

3. Set your API key for this terminal session (replace with your real key):

   **Mac:**  `export DASHSCOPE_API_KEY="sk-your-key-here"`
   **Windows (PowerShell):**  `$env:DASHSCOPE_API_KEY="sk-your-key-here"`

4. Start the server:  `python app.py`
   You should see Flask announce it's running on port 9000.

5. Open a SECOND terminal and test it:

   ```
   curl -X POST http://localhost:9000/classify \
     -H "Content-Type: application/json" \
     -d '{"text": "Oh I just LOVE waiting five minutes for the dashboard to load."}'
   ```

   Expected: a JSON response with `"category": "complaint"` and a summary
   mentioning sarcasm. **When you see that — the playground magic now runs
   in YOUR code.** Commit and push:

   ```
   git add .
   git commit -m "Hello world: Qwen classification endpoint working locally"
   git push
   ```

---

## Part B — Deploy to Alibaba Function Compute (30–60 min)

Console UIs change; if a step looks different, the concept still holds —
and the hackathon Discord answers Alibaba-specific questions fast.

1. In the Alibaba Cloud console, search for **Function Compute** and open it.
   Pick a region close to you (e.g. eu-west or me-east) and remember it.

2. **Create Function** → choose **Web Function** (it runs a web app like ours
   directly). Runtime: **Python 3.10+**.

3. Upload your code: zip `app.py` + `requirements.txt` and upload, or paste
   into the inline editor. Start command (tells Alibaba how to run the app):

   ```
   gunicorn -b 0.0.0.0:9000 app:app
   ```

   Listening port: **9000**.

4. **Environment variables** (in the function's configuration tab):
   add `DASHSCOPE_API_KEY` = your key. This is the cloud version of step A3 —
   and the reason the key never appears in your public repo.

5. Deploy. Function Compute gives you a public HTTPS URL.
   Visit it in a browser → you should see
   `{"status": "ok", "service": "signal-hello-world"}` — that's the health
   check answering from the cloud.

6. Run the same curl test as Part A, but with your cloud URL:

   ```
   curl -X POST https://YOUR-FUNCTION-URL/classify \
     -H "Content-Type: application/json" \
     -d '{"text": "app keeps crashing when i upload my receipt. third time this week!!"}'
   ```

7. **THE MOMENT IT ANSWERS: record your screen.** Show, in one take:
   - the Function Compute console with your function and its URL
   - the curl command (or browser tool) hitting that URL
   - Qwen's classification coming back
   - optionally, this code file on GitHub

   That recording is your **Proof of Alibaba Cloud Deployment** — an entire
   submission requirement, finished in week one. Save it somewhere safe.

---

## If something breaks (it might — that's normal)

- Read the error slowly, out loud. Then paste the FULL error + `app.py`
  into your AI assistant and ask it to explain before fixing.
- `401 Unauthorized` from Qwen → the env variable name or key value is wrong.
- Endpoint errors / timeouts → check the China-vs-international endpoint
  note at the top of `app.py`.
- Stuck > 90 minutes → stop, ask in the hackathon Discord, move to building
  the dataset (Day 3) meanwhile. Never let one snag eat a whole day.
