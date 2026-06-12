"""
Signal — Database models
========================
Five tables, one file. Each class = one table.
SQLAlchemy translates these Python classes into SQL, so we never write raw SQL
for basic operations. Switching from SQLite to Alibaba RDS later is a one-line
connection-string change — nothing here needs to move.
"""

from datetime import datetime, timezone
from flask_sqlalchemy import SQLAlchemy

# This object is the bridge between Flask and the database.
# It's created here but not tied to any app yet — app.py will call db.init_app(app)
# to connect them. This pattern (called "application factory") keeps models
# importable without needing a running Flask app.
db = SQLAlchemy()


# ---------------------------------------------------------------------------
# PipelineRun — one complete upload-to-review lifecycle
# ---------------------------------------------------------------------------
class PipelineRun(db.Model):
    __tablename__ = "pipeline_runs"

    id = db.Column(db.Integer, primary_key=True)
    filename = db.Column(db.String(255), nullable=False)
    started_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    finished_at = db.Column(db.DateTime, nullable=True)

    # The pipeline moves through these states in order:
    # ingesting -> triaging -> theming -> prioritizing -> drafting
    # -> awaiting_review -> complete | failed
    status = db.Column(db.String(50), nullable=False, default="ingesting")

    # A JSON blob storing running counts: items_total, excluded, themes, tickets.
    # Stored as text; we parse it in Python when we read it back.
    counts_json = db.Column(db.Text, nullable=True)

    # Relationships — SQLAlchemy uses these to let us write run.items, run.themes, etc.
    items = db.relationship("FeedbackItem", backref="run", lazy=True)
    themes = db.relationship("Theme", backref="run", lazy=True)
    audit_events = db.relationship("AuditEvent", backref="run", lazy=True)

    def __repr__(self):
        return f"<PipelineRun id={self.id} file={self.filename} status={self.status}>"


# ---------------------------------------------------------------------------
# FeedbackItem — one row from the uploaded CSV, with its classification
# ---------------------------------------------------------------------------
class FeedbackItem(db.Model):
    __tablename__ = "feedback_items"

    id = db.Column(db.Integer, primary_key=True)
    run_id = db.Column(db.Integer, db.ForeignKey("pipeline_runs.id"), nullable=False)

    # Fields from the CSV
    source = db.Column(db.String(50), nullable=False)  # app_store | support | nps | other
    text = db.Column(db.Text, nullable=False)
    date = db.Column(db.String(50), nullable=True)   # kept as string; format varies
    rating = db.Column(db.Float, nullable=True)

    # Fields written by Stage 1 (triage)
    category = db.Column(db.String(50), nullable=True)    # bug_report | feature_request | ...
    summary = db.Column(db.Text, nullable=True)           # Qwen's one-sentence neutral summary
    confidence = db.Column(db.Float, nullable=True)       # 0.0 – 1.0

    # Whether this item was dropped from the pipeline
    excluded = db.Column(db.Boolean, nullable=False, default=False)
    exclusion_reason = db.Column(db.String(255), nullable=True)

    def __repr__(self):
        return f"<FeedbackItem id={self.id} category={self.category} excluded={self.excluded}>"


# ---------------------------------------------------------------------------
# Theme — a cluster of related feedback items representing one user problem
# ---------------------------------------------------------------------------
class Theme(db.Model):
    __tablename__ = "themes"

    id = db.Column(db.Integer, primary_key=True)
    run_id = db.Column(db.Integer, db.ForeignKey("pipeline_runs.id"), nullable=False)

    title = db.Column(db.String(255), nullable=False)
    problem_statement = db.Column(db.Text, nullable=True)
    priority = db.Column(db.String(5), nullable=True)   # P1 | P2 | P3 | P4
    rationale = db.Column(db.Text, nullable=True)       # agent's written explanation

    # The evidence chain: a JSON array of FeedbackItem IDs.
    # e.g. "[12, 47, 83, 91]"
    # This is the guarantee that every theme is traceable to real input rows.
    item_ids = db.Column(db.Text, nullable=True)

    # Breakdown of which sources contributed, e.g. '{"app_store": 9, "support": 5}'
    sources_breakdown = db.Column(db.Text, nullable=True)

    # Relationship — lets us write theme.tickets
    tickets = db.relationship("DraftTicket", backref="theme", lazy=True)

    def __repr__(self):
        return f"<Theme id={self.id} priority={self.priority} title={self.title!r}>"


# ---------------------------------------------------------------------------
# DraftTicket — an AI-drafted ticket waiting for human approval
# ---------------------------------------------------------------------------
class DraftTicket(db.Model):
    __tablename__ = "draft_tickets"

    id = db.Column(db.Integer, primary_key=True)
    theme_id = db.Column(db.Integer, db.ForeignKey("themes.id"), nullable=False)

    title = db.Column(db.String(255), nullable=False)
    user_story = db.Column(db.Text, nullable=True)   # "As a..., I want..., so that..."

    # A JSON array of acceptance criteria strings, e.g.:
    # '["User can retry failed transfer", "Error message shown within 2s"]'
    acceptance_criteria = db.Column(db.Text, nullable=True)

    severity = db.Column(db.String(20), nullable=True)  # critical | high | medium | low

    # Approval lifecycle
    # pending_review -> approved | rejected
    status = db.Column(db.String(30), nullable=False, default="pending_review")
    edited_by_human = db.Column(db.Boolean, nullable=False, default=False)

    # Filled in after the ticket is sent to Jira (e.g. "PROJ-42")
    external_ref = db.Column(db.String(100), nullable=True)

    def __repr__(self):
        return f"<DraftTicket id={self.id} status={self.status} title={self.title!r}>"


# ---------------------------------------------------------------------------
# AuditEvent — immutable log of every agent decision and human action
# ---------------------------------------------------------------------------
class AuditEvent(db.Model):
    __tablename__ = "audit_events"

    id = db.Column(db.Integer, primary_key=True)
    run_id = db.Column(db.Integer, db.ForeignKey("pipeline_runs.id"), nullable=False)

    timestamp = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    # Which pipeline stage this event belongs to
    # (ingest | triage | theme_synthesis | prioritization | ticket_drafting | human)
    stage = db.Column(db.String(50), nullable=False)

    # A short machine-readable action label, e.g. "batch_classified" or "human_approved"
    action = db.Column(db.String(100), nullable=False)

    # Arbitrary JSON payload — whatever the stage wants to record
    detail_json = db.Column(db.Text, nullable=True)

    # Token accounting — only present for AI steps
    model_used = db.Column(db.String(50), nullable=True)
    tokens_in = db.Column(db.Integer, nullable=True)
    tokens_out = db.Column(db.Integer, nullable=True)

    def __repr__(self):
        return f"<AuditEvent id={self.id} stage={self.stage} action={self.action}>"
