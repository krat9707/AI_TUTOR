"""
StudyAI — Flask Application
"""

import os, json, uuid, threading
from datetime import datetime
from flask import (Flask, render_template, request, jsonify, session,
                   redirect, url_for, send_from_directory)
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
from dotenv import load_dotenv
from functools import wraps
from agent_handler import StudyAssistantHandler

load_dotenv()

# ── App setup ──────────────────────────────────────────────────────────────────
app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", os.urandom(32).hex())
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///studyai.db"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["UPLOAD_FOLDER"] = "./uploads"
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024  # 32 MB

os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)

db = SQLAlchemy(app)

# ── Models ─────────────────────────────────────────────────────────────────────
class User(db.Model):
    id          = db.Column(db.Integer, primary_key=True)
    uid         = db.Column(db.String(36), unique=True, default=lambda: str(uuid.uuid4()))
    username    = db.Column(db.String(80),  unique=True, nullable=False)
    email       = db.Column(db.String(120), unique=True, nullable=False)
    password    = db.Column(db.String(256), nullable=False)
    full_name   = db.Column(db.String(120), default="")
    avatar_seed = db.Column(db.String(40),  default="")
    created_at  = db.Column(db.DateTime,    default=datetime.utcnow)
    sessions    = db.relationship("StudySession", backref="user", lazy=True,
                                  cascade="all, delete-orphan")

class StudySession(db.Model):
    id            = db.Column(db.Integer, primary_key=True)
    sid           = db.Column(db.String(36), unique=True, default=lambda: str(uuid.uuid4()))
    user_id       = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    topic         = db.Column(db.String(200), default="")
    category      = db.Column(db.String(80),  default="")
    knowledge_lvl = db.Column(db.String(80),  default="")
    learning_goal = db.Column(db.Text,        default="")
    time_avail    = db.Column(db.String(120), default="")
    style         = db.Column(db.String(80),  default="")
    provider      = db.Column(db.String(40),  default="groq")
    model         = db.Column(db.String(80),  default="")
    analysis      = db.Column(db.Text,        default="")
    roadmap       = db.Column(db.Text,        default="")
    resources     = db.Column(db.Text,        default="")
    # ── NEW columns ──────────────────────────────────────────────────────────
    summary       = db.Column(db.Text,        default="")   # auto-generated summary
    notes         = db.Column(db.Text,        default="")   # AI study notes
    youtube_url   = db.Column(db.String(500), default="")   # YouTube link if any
    youtube_id      = db.Column(db.String(20),  default="")   # extracted video ID
    transcript_json  = db.Column(db.Text,        default="")   # raw timestamped chunks JSON
    chapters_json    = db.Column(db.Text,        default="")   # YouTube chapters JSON
    video_title      = db.Column(db.String(300), default="")   # real video title from YT
    pdf_filename  = db.Column(db.String(300), default="")   # stored PDF filename
    content_type  = db.Column(db.String(40),  default="topic")  # topic|pdf|youtube
    # ─────────────────────────────────────────────────────────────────────────
    created_at    = db.Column(db.DateTime,    default=datetime.utcnow)
    interactions  = db.relationship("Interaction", backref="study_session", lazy=True,
                                    cascade="all, delete-orphan")

class Interaction(db.Model):
    id         = db.Column(db.Integer, primary_key=True)
    session_id = db.Column(db.Integer, db.ForeignKey("study_session.id"), nullable=False)
    kind       = db.Column(db.String(40), default="chat")   # chat | quiz | rag | notes | summary
    question   = db.Column(db.Text,  default="")
    answer     = db.Column(db.Text,  default="")
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

# ── In-memory handler store ────────────────────────────────────────────────────
_handlers: dict = {}

def get_handler(sid: str):
    return _handlers.get(sid)

def set_handler(sid: str, h):
    _handlers[sid] = h

def _rebuild_handler(s: StudySession) -> StudyAssistantHandler:
    """Rebuild a handler from DB session object and store it."""
    h = StudyAssistantHandler(
        topic=s.topic, subject_category=s.category,
        knowledge_level=s.knowledge_lvl, learning_goal=s.learning_goal,
        time_available=s.time_avail, learning_style=s.style,
        model_name=s.model, provider=s.provider,
    )
    set_handler(s.sid, h)
    return h

def _get_or_rebuild(sid: str, s: StudySession) -> StudyAssistantHandler:
    """Get handler from memory or rebuild from DB if missing."""
    h = get_handler(sid)
    if not h:
        h = _rebuild_handler(s)
    return h

# ── Auth helpers ───────────────────────────────────────────────────────────────
def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if "user_id" not in session:
            return jsonify({"error": "Not authenticated"}), 401
        return f(*args, **kwargs)
    return decorated

def current_user():
    uid = session.get("user_id")
    return db.session.get(User, uid) if uid else None

# ── Page routes ────────────────────────────────────────────────────────────────
@app.route("/")
def landing():
    return render_template("landing.html", user=current_user())

@app.route("/about")
def about():
    return render_template("about.html", user=current_user())

@app.route("/login")
def login_page():
    if current_user():
        return redirect(url_for("dashboard"))
    return render_template("auth.html", mode="login")

@app.route("/register")
def register_page():
    if current_user():
        return redirect(url_for("dashboard"))
    return render_template("auth.html", mode="register")

@app.route("/dashboard")
def dashboard():
    u = current_user()
    if not u:
        return redirect(url_for("login_page"))
    sessions = (StudySession.query
                .filter_by(user_id=u.id)
                .order_by(StudySession.created_at.desc())
                .limit(6).all())
    return render_template("dashboard.html", user=u, sessions=sessions)

@app.route("/session/<sid>")
def session_view(sid):
    u = current_user()
    if not u:
        return redirect(url_for("login_page"))
    s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    messages = (Interaction.query
                .filter_by(session_id=s.id, kind="chat")
                .order_by(Interaction.created_at.asc()).all())
    return render_template("session.html", user=u, session=s, messages=messages)

@app.route("/history")
def history():
    u = current_user()
    if not u:
        return redirect(url_for("login_page"))
    sessions = (StudySession.query
                .filter_by(user_id=u.id)
                .order_by(StudySession.created_at.desc()).all())
    return render_template("history.html", user=u, sessions=sessions)

@app.route("/profile")
def profile():
    u = current_user()
    if not u:
        return redirect(url_for("login_page"))
    total_sessions = StudySession.query.filter_by(user_id=u.id).count()
    total_interactions = (db.session.query(Interaction)
                          .join(StudySession)
                          .filter(StudySession.user_id == u.id).count())
    return render_template("profile.html", user=u,
                           total_sessions=total_sessions,
                           total_interactions=total_interactions)

# ── Auth API ───────────────────────────────────────────────────────────────────
@app.route("/api/auth/register", methods=["POST"])
def api_register():
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data"}), 400
    username  = data.get("username", "").strip()
    email     = data.get("email", "").strip().lower()
    password  = data.get("password", "")
    full_name = data.get("full_name", "").strip()
    if not all([username, email, password]):
        return jsonify({"error": "All fields required"}), 400
    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters"}), 400
    if User.query.filter_by(username=username).first():
        return jsonify({"error": "Username already taken"}), 409
    if User.query.filter_by(email=email).first():
        return jsonify({"error": "Email already registered"}), 409
    u = User(username=username, email=email,
             password=generate_password_hash(password),
             full_name=full_name,
             avatar_seed=username[:2].upper())
    db.session.add(u)
    db.session.commit()
    session["user_id"] = u.id
    return jsonify({"ok": True, "redirect": "/dashboard"})

@app.route("/api/auth/login", methods=["POST"])
def api_login():
    data = request.get_json()
    identifier = data.get("identifier", "").strip()
    password   = data.get("password", "")
    u = (User.query.filter_by(username=identifier).first() or
         User.query.filter_by(email=identifier).first())
    if not u or not check_password_hash(u.password, password):
        return jsonify({"error": "Invalid credentials"}), 401
    session["user_id"] = u.id
    return jsonify({"ok": True, "redirect": "/dashboard"})

@app.route("/api/auth/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"ok": True, "redirect": "/"})

@app.route("/api/auth/update_profile", methods=["POST"])
@login_required
def api_update_profile():
    u = current_user()
    data = request.get_json()
    full_name = data.get("full_name", "").strip()
    if full_name:
        u.full_name = full_name
    new_pw = data.get("new_password", "").strip()
    if new_pw:
        if len(new_pw) < 6:
            return jsonify({"error": "Password too short"}), 400
        current_pw = data.get("current_password", "")
        if not check_password_hash(u.password, current_pw):
            return jsonify({"error": "Current password incorrect"}), 401
        u.password = generate_password_hash(new_pw)
    db.session.commit()
    return jsonify({"ok": True})

# ── Session API ────────────────────────────────────────────────────────────────
@app.route("/api/session/create", methods=["POST"])
@login_required
def api_create_session():
    u    = current_user()
    data = request.get_json()
    s    = StudySession(
        user_id       = u.id,
        topic         = data.get("topic", ""),
        category      = data.get("category", ""),
        knowledge_lvl = data.get("knowledge_level", ""),
        learning_goal = data.get("learning_goal", ""),
        time_avail    = data.get("time_available", ""),
        style         = data.get("learning_style", ""),
        provider      = data.get("provider", "groq"),
        model         = data.get("model", "llama-3.3-70b-versatile"),
        content_type  = data.get("content_type", "topic"),
    )
    db.session.add(s)
    db.session.commit()
    h = StudyAssistantHandler(
        topic=s.topic, subject_category=s.category,
        knowledge_level=s.knowledge_lvl, learning_goal=s.learning_goal,
        time_available=s.time_avail, learning_style=s.style,
        model_name=s.model, provider=s.provider,
    )
    set_handler(s.sid, h)
    return jsonify({"ok": True, "sid": s.sid})

@app.route("/api/session/<sid>/analyze", methods=["POST"])
@login_required
def api_analyze(sid):
    u = current_user()
    s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    h = _get_or_rebuild(sid, s)
    try:
        result = h.analyze_student()
        s.analysis = result
        db.session.commit()
        return jsonify({"ok": True, "result": result})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/session/<sid>/roadmap", methods=["POST"])
@login_required
def api_roadmap(sid):
    u = current_user()
    s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    h = _get_or_rebuild(sid, s)
    try:
        h.initialize_rag(collection_name=f"session_{sid}")
        steps = h.generate_roadmap_structured()
        import json as _json
        s.roadmap = _json.dumps(steps)
        db.session.commit()
        return jsonify({"ok": True, "roadmap": steps})
    except Exception as e:
        print(f"[ROADMAP] Error: {e}", flush=True)
        return jsonify({"error": str(e)}), 500

@app.route("/api/session/<sid>/resources", methods=["POST"])
@login_required
def api_resources(sid):
    u = current_user()
    s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    h = _get_or_rebuild(sid, s)
    try:
        result = h.find_resources()
        s.resources = result
        db.session.commit()
        return jsonify({"ok": True, "result": result})
    except Exception as e:
        fallback = f"## Resources for {s.topic}\n\nResource search encountered an error. Please retry.\n\nError: {str(e)}"
        s.resources = fallback
        db.session.commit()
        return jsonify({"ok": True, "result": fallback})

@app.route("/api/session/<sid>/quiz", methods=["POST"])
@login_required
def api_quiz(sid):
    u    = current_user()
    s    = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    h    = _get_or_rebuild(sid, s)
    data = request.get_json()
    try:
        h.initialize_rag(collection_name=f"session_{sid}")
        result = h.generate_quiz(
            difficulty_level=data.get("difficulty", "intermediate"),
            focus_areas="Generate all questions in English only",
            num_questions=int(data.get("num_questions", 5)),
        )
        inter = Interaction(session_id=s.id, kind="quiz",
                            question=f"Quiz — {data.get('num_questions', 5)}q",
                            answer=result)
        db.session.add(inter)
        db.session.commit()
        return jsonify({"ok": True, "result": result})
    except Exception as e:
        import traceback
        print(f"[QUIZ] Error: {e}\n{traceback.format_exc()}", flush=True)
        return jsonify({"error": str(e)}), 500

@app.route("/api/session/<sid>/tutor", methods=["POST"])
@login_required
def api_tutor(sid):
    u        = current_user()
    s        = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    h        = _get_or_rebuild(sid, s)
    data     = request.get_json()
    question = data.get("question", "")
    context  = data.get("context", "")
    if not question:
        return jsonify({"error": "Question required"}), 400
    try:
        result = h.get_tutoring(question, context)
        inter  = Interaction(session_id=s.id, kind="chat",
                             question=question, answer=result)
        db.session.add(inter)
        db.session.commit()
        return jsonify({"ok": True, "result": result})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ── RAG / Document routes ──────────────────────────────────────────────────────
@app.route("/api/session/<sid>/upload_doc", methods=["POST"])
@login_required
def api_upload_doc(sid):
    u = current_user()
    s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    h = _get_or_rebuild(sid, s)

    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400
    f    = request.files["file"]
    name = secure_filename(f.filename)
    if not name:
        return jsonify({"error": "Invalid filename"}), 400
    ext = name.rsplit(".", 1)[-1].lower()
    if ext not in ("pdf", "txt"):
        return jsonify({"error": "Only PDF and TXT supported"}), 400

    # Save permanently so PDF viewer can serve it
    save_name = f"{sid}_{name}"
    path = os.path.join(app.config["UPLOAD_FOLDER"], save_name)
    f.save(path)

    h.initialize_rag(collection_name=f"session_{sid}")
    ft = "pdf" if ext == "pdf" else "text"
    ok = h.add_document_to_rag(path, ft)

    if ok:
        s.content_type = ft
        if ft == "pdf":
            s.pdf_filename = save_name
        db.session.commit()

    size = round(os.path.getsize(path) / 1024, 1)
    return jsonify({"ok": ok, "name": name, "size": size,
                    "type": ext, "chunks": h.get_document_count(),
                    "pdf_filename": save_name if ft == "pdf" else ""})

@app.route("/api/session/<sid>/pdf/<filename>")
@login_required
def serve_pdf(sid, filename):
    """Serve a stored PDF for the in-app viewer."""
    u = current_user()
    s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    # Security: only serve files that belong to this session
    expected = f"{sid}_{filename}"
    if s.pdf_filename != expected:
        return jsonify({"error": "Not found"}), 404
    return send_from_directory(
        os.path.abspath(app.config["UPLOAD_FOLDER"]),
        expected,
        mimetype="application/pdf"
    )

@app.route("/api/session/<sid>/add_youtube", methods=["POST"])
@login_required
def api_add_youtube(sid):
    """Fetch YouTube transcript - with full debug logging."""
    import re, sys

    u    = current_user()
    s    = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    h    = _get_or_rebuild(sid, s)
    data = request.get_json() or {}
    url  = data.get("url", "").strip()

    print(f"[YT] url received: {repr(url)}", flush=True)

    if not url:
        return jsonify({"ok": False, "error": "No URL received by server."}), 400

    # ── Extract video ID ───────────────────────────────────────────────────
    patterns = [
        r"(?:v=)([A-Za-z0-9_-]{11})",
        r"youtu\.be/([A-Za-z0-9_-]{11})",
        r"embed/([A-Za-z0-9_-]{11})",
        r"shorts/([A-Za-z0-9_-]{11})",
        r"live/([A-Za-z0-9_-]{11})",
    ]
    video_id = None
    for p in patterns:
        m = re.search(p, url)
        if m:
            video_id = m.group(1)
            break

    print(f"[YT] video_id: {repr(video_id)}", flush=True)

    if not video_id:
        return jsonify({
            "ok": False,
            "error": f"Could not extract a video ID from URL: {url!r}. Supported formats: youtube.com/watch?v=ID, youtu.be/ID, shorts/ID, live/ID"
        }), 400

    transcript_text = None
    error_log = []

    # ── Strategy 1: youtube-transcript-api (new API >=0.6) ─────────────────
    print("[YT] Trying youtube-transcript-api...", flush=True)
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
        api = YouTubeTranscriptApi()

        # Try fetching English first, then fall back to any language
        chunks = None
        try:
            chunks = api.fetch(video_id, languages=["en", "en-US", "en-GB"])
        except Exception:
            pass

        if not chunks:
            try:
                # list() returns TranscriptList — iterate and fetch first available
                tlist = api.list(video_id)
                for t in tlist:
                    try:
                        chunks = t.fetch()
                        break
                    except Exception:
                        continue
            except Exception:
                pass

        # Older API (<0.6) uses class methods — try as fallback
        if not chunks:
            try:
                chunks = YouTubeTranscriptApi.get_transcript(video_id)
            except Exception:
                pass

        if chunks:
            # Serialise raw chunks for transcript display (text + start time)
            import json as _json
            raw_chunks = []
            parts = []
            for c in chunks:
                if isinstance(c, dict):
                    txt = c.get("text", "")
                    raw_chunks.append({"text": txt, "start": c.get("start", 0), "duration": c.get("duration", 0)})
                else:
                    txt = getattr(c, "text", str(c))
                    raw_chunks.append({"text": txt, "start": getattr(c, "start", 0), "duration": getattr(c, "duration", 0)})
                parts.append(txt)
            raw = " ".join(parts).strip()
            if raw:
                transcript_text = raw
                s.transcript_json = _json.dumps(raw_chunks)
                print(f"[YT] Got transcript ({len(raw)} chars, {len(raw_chunks)} chunks)", flush=True)
            else:
                error_log.append("youtube-transcript-api: transcript was empty")
        else:
            error_log.append("youtube-transcript-api: no transcript found for any language")

    except ImportError:
        msg = "youtube-transcript-api not installed — run: pip install youtube-transcript-api"
        print(f"[YT] {msg}", flush=True)
        error_log.append(msg)
    except Exception as e:
        msg = f"youtube-transcript-api: {type(e).__name__}: {e}"
        print(f"[YT] {msg}", flush=True)
        error_log.append(msg)

    # ── Strategy 2: yt-dlp with spoofed headers (avoids 429) ─────────────
    if not transcript_text:
        print("[YT] Trying yt-dlp fallback...", flush=True)
        try:
            import yt_dlp, tempfile, os, json as _json
            with tempfile.TemporaryDirectory() as tmpdir:
                ydl_opts = {
                    "skip_download": True,
                    "writeautomaticsub": True,
                    "writesubtitles": True,
                    "subtitleslangs": ["en", "en-US"],
                    "subtitlesformat": "json3",
                    "outtmpl": os.path.join(tmpdir, "%(id)s.%(ext)s"),
                    "quiet": True,
                    "no_warnings": True,
                    "socket_timeout": 20,
                    # Spoof a real browser to avoid 429 rate limiting
                    "http_headers": {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                        "Accept-Language": "en-US,en;q=0.9",
                    },
                    "extractor_args": {"youtube": {"player_client": ["web"]}},
                    "sleep_interval_subtitles": 1,
                }
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(
                        f"https://www.youtube.com/watch?v={video_id}",
                        download=True
                    )
                    title = info.get("title", "")

                lines_txt = []
                for fname in os.listdir(tmpdir):
                    if fname.endswith(".json3"):
                        with open(os.path.join(tmpdir, fname)) as f:
                            sub = _json.load(f)
                        for event in sub.get("events", []):
                            for seg in event.get("segs", []):
                                t = seg.get("utf8", "").strip()
                                if t and t != "\n":
                                    lines_txt.append(t)

                if lines_txt:
                    transcript_text = " ".join(lines_txt)
                    print(f"[YT] Got transcript via yt-dlp ({len(transcript_text)} chars)", flush=True)
                    if title and s.topic in ("", "YouTube Video"):
                        s.topic = title[:200]
                        s.video_title = title[:300]
                else:
                    error_log.append("yt-dlp: no subtitle data in output")


        except ImportError:
            msg = "yt-dlp not installed — run: pip install yt-dlp"
            print(f"[YT] {msg}", flush=True)
            error_log.append(msg)
        except Exception as e:
            msg = f"yt-dlp: {type(e).__name__}: {e}"
            print(f"[YT] {msg}", flush=True)
            error_log.append(msg)

    # ── Nothing worked ─────────────────────────────────────────────────────
    if not transcript_text:
        detail = " | ".join(error_log) or "Unknown error"
        print(f"[YT] FAILED: {detail}", flush=True)
        return jsonify({
            "ok": False,
            "error": f"Could not fetch transcript. Detail: {detail}"
        }), 400

    # ── Index into RAG ─────────────────────────────────────────────────────
    print("[YT] Indexing transcript into RAG...", flush=True)
    try:
        h.initialize_rag(collection_name=f"session_{sid}")
        ok = h.rag_helper.load_text_content(
            transcript_text,
            metadata={"source": url, "video_id": video_id, "type": "youtube"}
        )
    except Exception as e:
        return jsonify({"ok": False, "error": f"RAG indexing failed: {e}"}), 500

    if ok:
        s.youtube_url  = url
        s.youtube_id   = video_id
        s.content_type = "youtube"
        # Try to grab video title from transcript API if not already set
        if not s.video_title:
            try:
                import yt_dlp as _ydlp
                with _ydlp.YoutubeDL({"quiet":True,"no_warnings":True,"socket_timeout":10}) as ydl:
                    info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
                    s.video_title = info.get("title","")[:300]
                    # Extract chapters if present
                    chapters = info.get("chapters") or []
                    if chapters:
                        import json as _j
                        s.chapters_json = _j.dumps([
                            {"title": c.get("title",""), "start": c.get("start_time",0), "end": c.get("end_time",0)}
                            for c in chapters
                        ])
            except Exception as ce:
                print(f"[YT] Chapter/title fetch skipped: {ce}", flush=True)
        db.session.commit()

    print(f"[YT] Done. ok={ok}", flush=True)
    return jsonify({
        "ok": ok,
        "video_id": video_id,
        "transcript_length": len(transcript_text),
        "chunks": h.get_document_count() if ok else 0,
    })



@app.route("/api/session/<sid>/transcript", methods=["GET"])
@login_required
def api_transcript(sid):
    """Return transcript chunks + chapters. Fetches chapters live if not cached."""
    u = current_user()
    s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    import json as _json
    chunks   = []
    chapters = []

    try:
        if s.transcript_json:
            chunks = _json.loads(s.transcript_json)
    except Exception:
        pass

    # Try cached chapters first
    try:
        if s.chapters_json:
            chapters = _json.loads(s.chapters_json)
    except Exception:
        pass

    # If no chapters cached and we have a video_id, try fetching now
    if not chapters and s.youtube_id:
        try:
            import yt_dlp as _ydlp
            ydl_opts = {
                "quiet": True, "no_warnings": True,
                "skip_download": True, "socket_timeout": 8,
                "extract_flat": False,
            }
            with _ydlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(
                    f"https://www.youtube.com/watch?v={s.youtube_id}",
                    download=False
                )
                raw_chapters = info.get("chapters") or []
                if raw_chapters:
                    chapters = [
                        {"title": c.get("title",""), "start": c.get("start_time",0), "end": c.get("end_time",0)}
                        for c in raw_chapters
                    ]
                    s.chapters_json = _json.dumps(chapters)
                if not s.video_title:
                    s.video_title = info.get("title","")[:300]
                db.session.commit()
                print(f"[Chapters] fetched {len(chapters)} chapters for {s.youtube_id}", flush=True)
        except Exception as ce:
            print(f"[Chapters] fetch failed: {ce}", flush=True)

    if not chunks and not chapters:
        return jsonify({"ok": False, "error": "No transcript available"}), 404

    return jsonify({
        "ok": True,
        "chunks":   chunks,
        "chapters": chapters,
        "title":    s.video_title or s.topic
    })

@app.route("/api/session/<sid>/exam", methods=["POST"])
@login_required
def api_exam(sid):
    """Generate a topic-based exam — always based on the space topic, not video content."""
    u    = current_user()
    s    = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    h    = _get_or_rebuild(sid, s)
    data = request.get_json() or {}
    nq   = int(data.get("num_questions", 20))
    diff = data.get("difficulty", "mixed")
    tlim = int(data.get("time_limit", 30))
    try:
        # Exam is always topic-based — use general knowledge, not RAG content
        result = h.generate_quiz(
            difficulty_level=diff,
            focus_areas=f"comprehensive exam on the topic: {s.topic}. All questions in English.",
            num_questions=nq,
        )
        return jsonify({"ok": True, "result": result, "time_limit": tlim})
    except Exception as e:
        import traceback
        print(f"[EXAM] Error: {e}\n{traceback.format_exc()}", flush=True)
        return jsonify({"error": str(e)}), 500

@app.route("/api/session/<sid>/summarize", methods=["POST"])
@login_required
def api_summarize(sid):
    """Auto-generate a summary from uploaded content."""
    u = current_user()
    s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    h = _get_or_rebuild(sid, s)

    try:
        h.initialize_rag(collection_name=f"session_{sid}")
        result = h.summarize_content()
        s.summary = result
        inter = Interaction(session_id=s.id, kind="summary",
                            question="Auto-summary", answer=result)
        db.session.add(inter)
        db.session.commit()
        return jsonify({"ok": True, "result": result})
    except Exception as e:
        print(f"[SUMMARIZE] Error: {e}", flush=True)
        return jsonify({"error": str(e)}), 500

@app.route("/api/session/<sid>/notes", methods=["POST"])
@login_required
def api_notes(sid):
    """Generate structured study notes from uploaded content."""
    u = current_user()
    s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    h = _get_or_rebuild(sid, s)

    try:
        h.initialize_rag(collection_name=f"session_{sid}")
        result = h.generate_notes()
        s.notes = result
        inter = Interaction(session_id=s.id, kind="notes",
                            question="Study notes", answer=result)
        db.session.add(inter)
        db.session.commit()
        return jsonify({"ok": True, "result": result})
    except Exception as e:
        print(f"[NOTES] Error: {e}", flush=True)
        return jsonify({"error": str(e)}), 500

@app.route("/api/session/<sid>/rag_query", methods=["POST"])
@login_required
def api_rag_query(sid):
    u        = current_user()
    s        = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    h        = _get_or_rebuild(sid, s)
    data     = request.get_json()
    question = data.get("question", "")
    if not question:
        return jsonify({"error": "Question required"}), 400
    try:
        h.initialize_rag(collection_name=f"session_{sid}")
        result = h.query_documents(question)
        inter  = Interaction(session_id=s.id, kind="rag",
                             question=question, answer=result)
        db.session.add(inter)
        db.session.commit()
        return jsonify({"ok": True, "result": result,
                        "chunks": h.get_document_count()})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/session/<sid>/clear_docs", methods=["POST"])
@login_required
def api_clear_docs(sid):
    u = current_user()
    s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    h = get_handler(sid)

    # Delete stored PDF if any
    if s.pdf_filename:
        path = os.path.join(app.config["UPLOAD_FOLDER"], s.pdf_filename)
        if os.path.exists(path):
            os.remove(path)
        s.pdf_filename = ""
        s.content_type = "topic"

    s.youtube_url = ""
    s.summary     = ""
    s.notes       = ""
    db.session.commit()

    if h:
        h.initialize_rag(collection_name=f"session_{sid}")
        h.clear_documents()

    return jsonify({"ok": True})

@app.route("/api/session/<sid>/delete", methods=["DELETE"])
@login_required
def api_delete_session(sid):
    u = current_user()
    s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()

    # Clean up stored PDF
    if s.pdf_filename:
        path = os.path.join(app.config["UPLOAD_FOLDER"], s.pdf_filename)
        if os.path.exists(path):
            os.remove(path)

    db.session.delete(s)
    db.session.commit()
    _handlers.pop(sid, None)
    return jsonify({"ok": True})

@app.route("/api/session/<sid>/data", methods=["GET"])
@login_required
def api_session_data(sid):
    u = current_user()
    s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    h = get_handler(sid)
    doc_count = h.get_document_count() if h else 0
    return jsonify({
        "sid":           s.sid,
        "topic":         s.topic,
        "category":      s.category,
        "knowledge_level": s.knowledge_lvl,
        "learning_goal": s.learning_goal,
        "time_available": s.time_avail,
        "style":         s.style,
        "analysis":      s.analysis,
        "roadmap":       s.roadmap,
        "resources":     s.resources,
        "summary":       s.summary,
        "notes":         s.notes,
        "youtube_url":   s.youtube_url,
        "pdf_filename":  s.pdf_filename,
        "content_type":  s.content_type,
        "doc_count":     doc_count,
        "created_at":    s.created_at.strftime("%b %d, %Y"),
    })

@app.route("/api/user/stats", methods=["GET"])
@login_required
def api_user_stats():
    u = current_user()
    total_s = StudySession.query.filter_by(user_id=u.id).count()
    total_i = (db.session.query(Interaction)
               .join(StudySession)
               .filter(StudySession.user_id == u.id).count())
    recent = (StudySession.query.filter_by(user_id=u.id)
              .order_by(StudySession.created_at.desc()).limit(3).all())
    return jsonify({
        "total_sessions":     total_s,
        "total_interactions": total_i,
        "recent": [{"sid": s.sid, "topic": s.topic,
                    "category": s.category,
                    "content_type": s.content_type,
                    "date": s.created_at.strftime("%b %d")} for s in recent],
    })


# ── Init + Auto-migrate ───────────────────────────────────────────────────────
def _auto_migrate():
    """Add any new model columns that are missing from the existing SQLite DB."""
    db.create_all()
    from sqlalchemy import inspect, text
    inspector = inspect(db.engine)
    models = [User, StudySession, Interaction]
    with db.engine.connect() as conn:
        for model in models:
            tname = model.__tablename__
            try:
                existing = {c["name"] for c in inspector.get_columns(tname)}
            except Exception:
                continue
            for col in model.__table__.columns:
                if col.name in existing:
                    continue
                ctype = col.type.compile(dialect=db.engine.dialect)
                default_sql = ""
                if col.default is not None and col.default.is_scalar:
                    val = col.default.arg
                    if isinstance(val, str):
                        default_sql = f" DEFAULT '{val.replace(chr(39), chr(39)*2)}'"
                    elif isinstance(val, (int, float)):
                        default_sql = f" DEFAULT {val}"
                sql = f'ALTER TABLE "{tname}" ADD COLUMN "{col.name}" {ctype}{default_sql}'
                try:
                    conn.execute(text(sql))
                    conn.commit()
                    print(f"[migrate] + {tname}.{col.name}")
                except Exception as ex:
                    print(f"[migrate] skip {tname}.{col.name}: {ex}")

with app.app_context():
    _auto_migrate()