"""
StudyAI — Flask Application
"""

import os, json, uuid, threading, secrets
from datetime import datetime
from urllib.parse import urlencode
from flask import (Flask, render_template, request, jsonify, session,
                   redirect, url_for, send_from_directory)
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
from dotenv import load_dotenv
from providers import available_models, get_model, get_default, get_doc_models
from functools import wraps
from agent_handler import StudyAssistantHandler

load_dotenv()

# ── Google OAuth config ────────────────────────────────────────────────────────
GOOGLE_CLIENT_ID     = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")
GOOGLE_REDIRECT_URI  = os.getenv("GOOGLE_REDIRECT_URI", "http://localhost:5000/auth/google/callback")

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
    google_id   = db.Column(db.String(100), unique=True, nullable=True)
    full_name   = db.Column(db.String(120), default="")
    avatar_seed = db.Column(db.String(40),  default="")
    avatar_url  = db.Column(db.String(200), default="")  # relative path e.g. avatars/uid.jpg
    pref_model_id = db.Column(db.String(40), default="groq_llama")  # active model
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
    raw_text      = db.Column(db.Text,        default="")   # pasted text content
    content_type  = db.Column(db.String(40),  default="topic")  # topic|pdf|youtube
    embed_key         = db.Column(db.String(64),  default="")   # sha256 of source bytes (stable cache key)
    annotations_json  = db.Column(db.Text, default="[]")  # PDF highlight annotations JSON
    # ─────────────────────────────────────────────────────────────────────────
    created_at    = db.Column(db.DateTime,    default=datetime.utcnow)
    interactions  = db.relationship("Interaction", backref="study_session", lazy=True,
                                    cascade="all, delete-orphan")

class Interaction(db.Model):
    id          = db.Column(db.Integer, primary_key=True)
    session_id  = db.Column(db.Integer, db.ForeignKey("study_session.id"), nullable=False)
    kind        = db.Column(db.String(40), default="chat")
    question    = db.Column(db.Text,  default="")
    answer      = db.Column(db.Text,  default="")
    thread_id   = db.Column(db.String(36), default="")
    thread_name = db.Column(db.String(200), default="New Chat")
    created_at  = db.Column(db.DateTime, default=datetime.utcnow)

# ── In-memory handler store ────────────────────────────────────────────────────
_handlers: dict = {}

def get_handler(sid: str):
    return _handlers.get(sid)

def set_handler(sid: str, h):
    _handlers[sid] = h

def _rebuild_handler(s: StudySession) -> StudyAssistantHandler:
    """Rebuild handler using the session owner's CURRENT preferred model.

    The model baked into s.model / s.provider reflects what was selected at
    session-creation time.  If the user has since switched the model toggle we
    must respect that preference — otherwise a handler cached before the switch
    (and subsequently evicted) would silently re-create with the old model.
    """
    # Resolve live preference for this session's owner
    owner   = User.query.get(s.user_id)
    pref_id = (owner.pref_model_id if owner else None) or "groq_llama"
    pref    = get_model(pref_id) or get_default()
    live_provider  = pref["provider"]
    live_model     = pref["model"]
    print(f"[Handler] Building with {pref_id} ({live_provider}/{live_model})", flush=True)
    h = StudyAssistantHandler(
        topic=s.topic, subject_category=s.category,
        knowledge_level=s.knowledge_lvl, learning_goal=s.learning_goal,
        time_available=s.time_avail, learning_style=s.style,
        model_name=live_model, provider=live_provider,
    )
    # Rebuild in-memory RAG from stored text (no local model needed).
    _rebuild_text = s.raw_text or ""
    # Fallback for older sessions: reconstruct from transcript_json
    if not _rebuild_text and s.transcript_json:
        try:
            import json as _rj
            _tc = _rj.loads(s.transcript_json)
            _rebuild_text = " ".join(
                c.get("text", "") if isinstance(c, dict) else str(c)
                for c in _tc
            )
        except Exception:
            pass
    # Always try to rebuild if we have any text for a content session
    _is_content = s.content_type in ("youtube", "pdf", "text") or bool(s.transcript_json)
    if _rebuild_text and _is_content:
        try:
            from rag_helper import RAGHelper
            h.rag_helper = RAGHelper(
                collection_name=f"session_{s.sid}",
                sid=s.sid,
                cache_dir=app.config["UPLOAD_FOLDER"],
            )
            # Use stored embed_key (hash of source bytes) for stable cache hit;
            # fall back to hashing raw_text for sessions created before this column
            h.rag_helper.load_from_cache_or_raw(
                _rebuild_text,
                source_key=s.embed_key or ""
            )
            print(f"[RAG] Rebuilt {h.rag_helper.count()} chunks for {s.sid} (type={s.content_type})", flush=True)
        except Exception as e:
            print(f"[RAG] Rebuild failed for {s.sid}: {e}", flush=True)
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

@app.route("/api/doc-models", methods=["GET"])
def api_doc_models():
    """Models suitable for document RAG (large context, strong comprehension)."""
    return jsonify({"ok": True, "models": get_doc_models()})

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
                .limit(10).all())
    from providers import available_models
    models = available_models()
    return render_template("dashboard.html", user=u, models=models, sessions=sessions)

@app.route("/session/<sid>")
def session_view(sid):
    u = current_user()
    if not u:
        return redirect(url_for("login_page"))
    s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    messages = (Interaction.query
                .filter_by(session_id=s.id, kind="chat")
                .order_by(Interaction.created_at.asc()).all())
    if s.content_type == "chat":
        return redirect(url_for("chat_session_view", sid=sid))
    if s.content_type == "text":
        try:
            return render_template("text_session.html", user=u, session=s)
        except Exception as e:
            import traceback
            print(f"[text_session render error] {e}\n{traceback.format_exc()}", flush=True)
            return render_template("session.html", user=u, session=s, messages=messages)
    if s.content_type == "pdf":
        pdf_url = ""
        if s.pdf_filename:
            original = s.pdf_filename[len(sid) + 1:]  # strip 'sid_' prefix
            pdf_url  = url_for('serve_pdf', sid=sid, filename=original)
        return render_template("pdf_session.html", user=u, session=s, pdf_url=pdf_url)
    if s.content_type == "audio":
        audio_url = ""
        if s.pdf_filename:
            original  = s.pdf_filename[len(sid) + 1:]
            audio_url = url_for('serve_audio', sid=sid, filename=original)
        try:
            return render_template("audio_session.html", user=u, session=s, audio_url=audio_url)
        except Exception as e:
            import traceback
            print(f"[audio_session render error] {e}\n{traceback.format_exc()}", flush=True)
            return render_template("session.html", user=u, session=s, messages=messages)
    return render_template("session.html", user=u, session=s, messages=messages)

@app.route("/chat/<sid>")
def chat_session_view(sid):
    u = current_user()
    if not u:
        return redirect(url_for("login_page"))
    s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    return render_template("chat_session.html", user=u, session=s)

@app.route("/api/session/<sid>/threads", methods=["GET"])
@login_required
def api_get_threads(sid):
    u = current_user()
    s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    rows = (Interaction.query
            .filter_by(session_id=s.id)
            .filter(Interaction.thread_id != "")
            .order_by(Interaction.created_at.asc()).all())
    seen = {}
    for row in rows:
        if row.thread_id not in seen:
            seen[row.thread_id] = {"id": row.thread_id, "name": row.thread_name or "New Chat"}
    return jsonify({"ok": True, "threads": list(seen.values())})

@app.route("/api/session/<sid>/thread/new", methods=["POST"])
@login_required
def api_new_thread(sid):
    u = current_user()
    StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    tid = str(uuid.uuid4())
    return jsonify({"ok": True, "thread_id": tid, "name": "New Chat"})

@app.route("/api/session/<sid>/thread/<tid>/messages", methods=["GET"])
@login_required
def api_thread_messages(sid, tid):
    u = current_user()
    s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    msgs = (Interaction.query
            .filter_by(session_id=s.id, thread_id=tid)
            .order_by(Interaction.created_at.asc()).all())
    out = []
    for m in msgs:
        if m.question:
            out.append({"role": "user",      "content": m.question})
        if m.answer:
            out.append({"role": "assistant", "content": m.answer, "kind": m.kind})
    return jsonify({"ok": True, "messages": out})

@app.route("/api/session/<sid>/thread/<tid>/rename", methods=["POST"])
@login_required
def api_rename_thread(sid, tid):
    u    = current_user()
    s    = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    name = (request.get_json() or {}).get("name", "New Chat")[:120]
    Interaction.query.filter_by(session_id=s.id, thread_id=tid).update({"thread_name": name})
    db.session.commit()
    return jsonify({"ok": True})

@app.route("/api/session/<sid>/thread/<tid>/delete", methods=["DELETE"])
@login_required
def api_delete_thread(sid, tid):
    u = current_user()
    s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    Interaction.query.filter_by(session_id=s.id, thread_id=tid).delete()
    db.session.commit()
    return jsonify({"ok": True})

@app.route("/api/session/<sid>/thread/<tid>/chat", methods=["POST"])
@login_required
def api_chat_message(sid, tid):
    u       = current_user()
    s       = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    h       = _get_or_rebuild(sid, s)
    data    = request.get_json() or {}
    message = data.get("message", "").strip()
    history = data.get("history", [])
    tname   = data.get("thread_name", "New Chat")
    if not message:
        return jsonify({"ok": False, "error": "Empty message"}), 400

    # ── Safety net: ensure RAG is loaded for content sessions ─────────
    if h.rag_helper is None or h.rag_helper.count() == 0:
        _rag_text = s.raw_text or ""
        if not _rag_text and s.transcript_json:
            try:
                import json as _cj
                _tc = _cj.loads(s.transcript_json)
                _rag_text = " ".join(
                    c.get("text", "") if isinstance(c, dict) else str(c)
                    for c in _tc
                )
            except Exception:
                pass
        if _rag_text:
            try:
                from rag_helper import RAGHelper
                h.rag_helper = RAGHelper(
                    collection_name=f"session_{sid}",
                    sid=sid,
                    cache_dir=app.config["UPLOAD_FOLDER"],
                )
                h.rag_helper.load_from_cache_or_raw(_rag_text,
                    source_key=s.embed_key or "")
                print(f"[Chat] Lazy-loaded {h.rag_helper.count()} RAG chunks for {sid}", flush=True)
            except Exception as _re:
                print(f"[Chat] RAG lazy-load failed: {_re}", flush=True)

    try:
        ctx_lines = []
        for m in history[-6:]:
            role = "Student" if m.get("role") == "user" else "Tutor"
            ctx_lines.append(f"{role}: {m.get('content','')}")
        ctx = "\n".join(ctx_lines)
        result = h.get_tutoring(student_question=message, context=ctx)
        inter = Interaction(session_id=s.id, kind="chat",
                            question=message, answer=result,
                            thread_id=tid, thread_name=tname)
        db.session.add(inter)
        db.session.flush()
        count = Interaction.query.filter_by(session_id=s.id, thread_id=tid).count()
        if count <= 1:
            short = message[:80].strip()
            Interaction.query.filter_by(session_id=s.id, thread_id=tid).update({"thread_name": short})
            tname = short
        db.session.commit()
        return jsonify({"ok": True, "result": result, "thread_name": tname})
    except Exception as e:
        import traceback; print(traceback.format_exc())
        return jsonify({"ok": False, "error": str(e)}), 500

@app.route("/api/session/<sid>/thread/<tid>/quiz", methods=["POST"])
@login_required
def api_chat_quiz(sid, tid):
    u    = current_user()
    s    = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    h    = _get_or_rebuild(sid, s)
    data = request.get_json() or {}
    hint = data.get("topic", s.topic or "the current topic")
    n    = int(data.get("num_questions", 5))
    diff = data.get("difficulty", "intermediate")
    tname = data.get("thread_name", "New Chat")
    try:
        result = h.generate_quiz(difficulty_level=diff, focus_areas=hint, num_questions=n)
        inter  = Interaction(session_id=s.id, kind="quiz",
                             question=f"Quiz: {hint}", answer=result,
                             thread_id=tid, thread_name=tname)
        db.session.add(inter)
        db.session.commit()
        return jsonify({"ok": True, "result": result})
    except Exception as e:
        import traceback; print(traceback.format_exc())
        return jsonify({"ok": False, "error": str(e)}), 500


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
    if not u:
        return jsonify({"error": "Invalid credentials"}), 401
    if not u.password:
        return jsonify({"error": "This account uses Google sign-in. Please click 'Continue with Google'."}), 401
    if not check_password_hash(u.password, password):
        return jsonify({"error": "Invalid credentials"}), 401
    session["user_id"] = u.id
    return jsonify({"ok": True, "redirect": "/dashboard"})

@app.route("/api/auth/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"ok": True, "redirect": "/"})

# ── Google OAuth ────────────────────────────────────────────────────────────────
@app.route("/auth/google")
def google_login():
    if not GOOGLE_CLIENT_ID:
        return "Google OAuth is not configured.", 500
    state = secrets.token_urlsafe(32)
    session["oauth_state"] = state
    params = {
        "client_id":     GOOGLE_CLIENT_ID,
        "redirect_uri":  GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope":         "openid email profile",
        "state":         state,
        "access_type":   "online",
    }
    return redirect("https://accounts.google.com/o/oauth2/v2/auth?" + urlencode(params))

@app.route("/auth/google/callback")
def google_callback():
    import requests as req

    # ── CSRF guard ─────────────────────────────────────────────────────────────
    if request.args.get("state") != session.pop("oauth_state", None):
        return redirect(url_for("login_page"))

    error = request.args.get("error")
    if error:
        return redirect(url_for("login_page"))

    code = request.args.get("code")
    if not code:
        return redirect(url_for("login_page"))

    # ── Exchange code for tokens ────────────────────────────────────────────────
    token_resp = req.post("https://oauth2.googleapis.com/token", data={
        "code":          code,
        "client_id":     GOOGLE_CLIENT_ID,
        "client_secret": GOOGLE_CLIENT_SECRET,
        "redirect_uri":  GOOGLE_REDIRECT_URI,
        "grant_type":    "authorization_code",
    }, timeout=10)
    if not token_resp.ok:
        return redirect(url_for("login_page"))
    access_token = token_resp.json().get("access_token")

    # ── Fetch Google user info ─────────────────────────────────────────────────
    info_resp = req.get("https://www.googleapis.com/oauth2/v3/userinfo",
                        headers={"Authorization": f"Bearer {access_token}"}, timeout=10)
    if not info_resp.ok:
        return redirect(url_for("login_page"))
    ginfo     = info_resp.json()
    google_id = ginfo.get("sub")
    email     = (ginfo.get("email") or "").lower()
    full_name = ginfo.get("name", "")

    if not google_id or not email:
        return redirect(url_for("login_page"))

    # ── Find or create user ────────────────────────────────────────────────────
    u = User.query.filter_by(google_id=google_id).first()
    if not u:
        # Link to existing account with the same email
        u = User.query.filter_by(email=email).first()
        if u:
            u.google_id = google_id
        else:
            # Create a new account
            base = email.split("@")[0]
            username = base
            counter  = 1
            while User.query.filter_by(username=username).first():
                username = f"{base}{counter}"
                counter += 1
            u = User(
                username    = username,
                email       = email,
                password    = "",
                google_id   = google_id,
                full_name   = full_name,
                avatar_seed = (full_name[:2] or username[:2]).upper(),
            )
            db.session.add(u)
        db.session.commit()

    session["user_id"] = u.id
    return redirect(url_for("dashboard"))

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

@app.route("/api/auth/upload_avatar", methods=["POST"])
@login_required
def api_upload_avatar():
    u = current_user()
    if "avatar" not in request.files:
        return jsonify({"error": "No file provided"}), 400
    f = request.files["avatar"]
    if not f.filename:
        return jsonify({"error": "No file selected"}), 400
    ext = f.filename.rsplit(".", 1)[-1].lower() if "." in f.filename else ""
    if ext not in {"jpg", "jpeg", "png", "gif", "webp"}:
        return jsonify({"error": "Only JPG, PNG, GIF, WEBP allowed"}), 400
    avatars_dir = os.path.join(app.root_path, "static", "avatars")
    os.makedirs(avatars_dir, exist_ok=True)
    filename = secure_filename(f"{u.uid}.{ext}")
    # Remove any previous avatar file for this user (different extension)
    for old in os.listdir(avatars_dir):
        if old.startswith(f"{u.uid}.") and old != filename:
            try:
                os.remove(os.path.join(avatars_dir, old))
            except OSError:
                pass
    f.save(os.path.join(avatars_dir, filename))
    u.avatar_url = f"avatars/{filename}"
    db.session.commit()
    return jsonify({"ok": True, "avatar_url": u.avatar_url})

# ── Session API ────────────────────────────────────────────────────────────────
@app.route("/api/session/create", methods=["POST"])
@login_required
def api_create_session():
    u    = current_user()
    data = request.get_json()
    # Resolve provider + model from user preference, allow request override
    _pref         = get_model(u.pref_model_id or "groq_llama") or get_default()
    _req_provider = data.get("provider") or _pref["provider"]
    _req_model    = data.get("model")    or _pref["model"]
    s    = StudySession(
        user_id       = u.id,
        topic         = data.get("topic", ""),
        category      = data.get("category", ""),
        knowledge_lvl = data.get("knowledge_level", ""),
        learning_goal = data.get("learning_goal", ""),
        time_avail    = data.get("time_available", ""),
        style         = data.get("learning_style", ""),
        provider      = _req_provider,
        model         = _req_model,
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


# ── Mistral OCR helper ─────────────────────────────────────────────────────────

def _ocr_pdf_mistral(path: str) -> dict | None:
    """
    Call mistral-ocr-latest on a PDF file.
    Returns the full API response dict (with pages + images) or None on failure.
    Requires MISTRAL_API_KEY in environment.
    """
    import base64, httpx as _httpx
    api_key = os.environ.get("MISTRAL_API_KEY", "").strip()
    if not api_key:
        print("[OCR] No MISTRAL_API_KEY — skipping OCR, will use pypdf fallback", flush=True)
        return None
    try:
        with open(path, "rb") as _f:
            pdf_b64 = base64.standard_b64encode(_f.read()).decode()
        print(f"[OCR] Sending to mistral-ocr-latest ({round(len(pdf_b64)/1024)}KB b64)…", flush=True)
        r = _httpx.post(
            "https://api.mistral.ai/v1/ocr",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "model": "mistral-ocr-latest",
                "document": {
                    "type": "document_url",
                    "document_url": f"data:application/pdf;base64,{pdf_b64}"
                },
                "include_image_base64": True,
            },
            timeout=180,
        )
        r.raise_for_status()
        result = r.json()
        pages = result.get("pages", [])
        total_imgs = sum(len(p.get("images", [])) for p in pages)
        print(f"[OCR] Done: {len(pages)} pages, {total_imgs} images extracted", flush=True)
        return result
    except Exception as _e:
        print(f"[OCR] mistral-ocr-latest failed: {_e} — falling back to pypdf", flush=True)
        return None


def _save_ocr_figures(sid: str, pages: list) -> int:
    """
    Extract base64 images from OCR pages and save as
    uploads/{sid}_figures.json  →  [{page, id, b64, mime}]
    Returns count of images saved.
    """
    figures = []
    for page in pages:
        pnum = page.get("index", 0) + 1
        for img in page.get("images", []):
            b64 = img.get("image_base64", "")
            if not b64:
                continue
            # Detect mime from base64 header or default to jpeg
            mime = "image/jpeg"
            if b64.startswith("iVBOR"):
                mime = "image/png"
            elif b64.startswith("/9j/"):
                mime = "image/jpeg"
            elif b64.startswith("R0lGOD"):
                mime = "image/gif"
            figures.append({
                "page":  pnum,
                "id":    img.get("id", f"fig_{pnum}_{len(figures)}"),
                "b64":   b64,
                "mime":  mime,
                "top_left_x":  img.get("top_left_x"),
                "top_left_y":  img.get("top_left_y"),
                "width":       img.get("width"),
                "height":      img.get("height"),
            })
    if figures:
        import json as _json
        fpath = os.path.join(app.config["UPLOAD_FOLDER"], f"{sid}_figures.json")
        with open(fpath, "w") as _f:
            _json.dump(figures, _f)
        print(f"[OCR] Saved {len(figures)} figures → {fpath}", flush=True)
    return len(figures)


# ── Audio transcription helper ─────────────────────────────────────────────────

def _transcribe_audio_mistral(audio_bytes: bytes, filename: str) -> str | None:
    """
    Transcribe audio using Mistral's Voxtral model.
    Returns transcript text, or None if the API call fails / key is missing.
    """
    import httpx as _httpx
    api_key = os.environ.get("MISTRAL_API_KEY", "").strip()
    if not api_key:
        print("[AUDIO] No MISTRAL_API_KEY — cannot transcribe audio", flush=True)
        return None

    ext  = os.path.splitext(filename.lower())[1]
    mime = {
        ".mp3":  "audio/mpeg",
        ".wav":  "audio/wav",
        ".m4a":  "audio/mp4",
        ".ogg":  "audio/ogg",
        ".flac": "audio/flac",
        ".webm": "audio/webm",
        ".mp4":  "audio/mp4",
    }.get(ext, "audio/mpeg")

    print(f"[AUDIO] Sending {len(audio_bytes)//1024} KB to Voxtral (mime={mime})…", flush=True)
    try:
        r = _httpx.post(
            "https://api.mistral.ai/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {api_key}"},
            files={"file": (filename, audio_bytes, mime)},
            data={"model": "voxtral-mini-2507"},
            timeout=300,
        )
        r.raise_for_status()
        data = r.json()
        text = data.get("text", "").strip()
        print(f"[AUDIO] Transcription done: {len(text)} chars", flush=True)
        return text or None
    except Exception as e:
        print(f"[AUDIO] Voxtral transcription failed: {e}", flush=True)
        return None


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

    ft = "pdf" if ext == "pdf" else "text"
    s.content_type = ft
    num_figures = 0

    # ── Extract text ──────────────────────────────────────────────────
    if ft == "pdf":
        s.pdf_filename = save_name

        # Hash file bytes — stable cache key regardless of OCR non-determinism
        import hashlib as _hl
        with open(path, "rb") as _pf:
            s.embed_key = _hl.sha256(_pf.read()).hexdigest()[:16]

        # ── Cache check BEFORE OCR ─────────────────────────────────────
        # If this exact file was embedded before, skip OCR + embed entirely
        from rag_helper import RAGHelper, _cache_path, _load_cache
        _cache_file = _cache_path(app.config["UPLOAD_FOLDER"], s.embed_key)
        _cached_chunks, _cached_emb = _load_cache(
            _cache_file, s.embed_key,
            cache_dir=app.config["UPLOAD_FOLDER"]
        )
        if _cached_chunks is not None and _cached_emb is not None:
            print(f"[upload_doc] Cache hit for {s.embed_key} — "
                  f"skipping OCR+embed ({len(_cached_chunks)} chunks)", flush=True)
            h.rag_helper = RAGHelper(
                collection_name=f"session_{sid}",
                sid=sid,
                cache_dir=app.config["UPLOAD_FOLDER"],
            )
            h.rag_helper.chunks           = _cached_chunks
            h.rag_helper.embeddings       = _cached_emb
            h.rag_helper._last_cache_file = _cache_file
            # raw_text may already be in DB from a prior session with same file;
            # if not, we still need it for summarise/notes/quiz — run pypdf as
            # a lightweight fallback (no API call, just text extraction)
            if not s.raw_text:
                try:
                    from pypdf import PdfReader
                    reader = PdfReader(path)
                    s.raw_text = "\n\n".join(
                        f"[Page {i+1}]\n{(pg.extract_text() or '').strip()}"
                        for i, pg in enumerate(reader.pages)
                        if (pg.extract_text() or '').strip()
                    )
                except Exception as _pe:
                    print(f"[upload_doc] pypdf for raw_text failed: {_pe}", flush=True)
        else:
            # ── Cache miss: run OCR → embed → save ────────────────────
            # Primary: Mistral OCR (handles scanned PDFs, images, tables)
            ocr_result = _ocr_pdf_mistral(path)
            if ocr_result and ocr_result.get("pages"):
                pages = ocr_result["pages"]
                s.raw_text = "\n\n".join(
                    f"[Page {p.get('index',0)+1}]\n{(p.get('markdown') or '').strip()}"
                    for p in pages if (p.get('markdown') or '').strip()
                )
                h.rag_helper = RAGHelper(
                    collection_name=f"session_{sid}",
                    sid=sid,
                    cache_dir=app.config["UPLOAD_FOLDER"],
                )
                h.rag_helper.load_pdf_ocr(pages, raw_text=s.raw_text,
                                          source_key=s.embed_key)
                num_figures = _save_ocr_figures(sid, pages)
            else:
                # Fallback: pypdf
                try:
                    from pypdf import PdfReader
                    reader = PdfReader(path)
                    s.raw_text = "\n\n".join(
                        f"[Page {i+1}]\n{(pg.extract_text() or '').strip()}"
                        for i, pg in enumerate(reader.pages)
                        if (pg.extract_text() or '').strip()
                    )
                except Exception as _e:
                    print(f"[upload_doc] pypdf fallback failed: {_e}", flush=True)
                if s.raw_text:
                    h.rag_helper = RAGHelper(
                        collection_name=f"session_{sid}",
                        sid=sid,
                        cache_dir=app.config["UPLOAD_FOLDER"],
                    )
                    h.rag_helper.load_raw(s.raw_text, source_key=s.embed_key)
    else:
        import hashlib as _hl2
        with open(path, "rb") as _tf:
            s.embed_key = _hl2.sha256(_tf.read()).hexdigest()[:16]
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as _f:
                s.raw_text = _f.read()
        except Exception as _e:
            print(f"[upload_doc] could not read text: {_e}", flush=True)
        if s.raw_text:
            from rag_helper import RAGHelper
            h.rag_helper = RAGHelper(
                collection_name=f"session_{sid}",
                sid=sid,
                cache_dir=app.config["UPLOAD_FOLDER"],
            )
            h.rag_helper.load_raw(s.raw_text, source_key=s.embed_key)

    db.session.commit()

    chunks = h.get_document_count()
    size   = round(os.path.getsize(path) / 1024, 1)
    return jsonify({
        "ok":          True,
        "name":        name,
        "size":        size,
        "type":        ext,
        "chunks":      chunks,
        "figures":     num_figures,
        "pdf_filename": save_name if ft == "pdf" else "",
    })

@app.route("/api/session/<sid>/upload_audio", methods=["POST"])
@login_required
def api_upload_audio(sid):
    """
    Receive an audio file, transcribe it with Mistral Voxtral,
    cache both the transcript text and the RAG embeddings, and
    initialise the session handler ready for AI features.
    """
    import hashlib as _hl
    u = current_user()
    s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()

    if "audio" not in request.files:
        return jsonify({"ok": False, "error": "No audio file provided"}), 400

    f    = request.files["audio"]
    name = secure_filename(f.filename or "recording.webm")
    ext  = name.rsplit(".", 1)[-1].lower()
    if ext not in ("mp3", "wav", "m4a", "ogg", "flac", "webm", "mp4"):
        return jsonify({"ok": False, "error": "Unsupported audio format. Use MP3, WAV, M4A, OGG, FLAC, or WEBM."}), 400

    audio_bytes = f.read()
    if not audio_bytes:
        return jsonify({"ok": False, "error": "Empty audio file"}), 400

    # ── Save audio file to disk ───────────────────────────────────────
    save_name = f"{sid}_{name}"
    path      = os.path.join(app.config["UPLOAD_FOLDER"], save_name)
    with open(path, "wb") as af:
        af.write(audio_bytes)

    # ── Stable cache key ──────────────────────────────────────────────
    embed_key = _hl.sha256(audio_bytes).hexdigest()[:16]

    # ── Transcript cache: skip Voxtral if already transcribed ─────────
    transcript_cache = os.path.join(
        app.config["UPLOAD_FOLDER"], f"transcript_{embed_key}.txt"
    )
    if os.path.exists(transcript_cache):
        print(f"[AUDIO] Transcript cache hit for {embed_key}", flush=True)
        with open(transcript_cache, "r", encoding="utf-8") as tc:
            transcript = tc.read()
    else:
        transcript = _transcribe_audio_mistral(audio_bytes, name)
        if not transcript:
            # Clean up saved file on failure
            if os.path.exists(path):
                os.remove(path)
            return jsonify({
                "ok": False,
                "error": "Transcription failed. Ensure MISTRAL_API_KEY is set and the model voxtral-mini-2507 is accessible."
            }), 500
        with open(transcript_cache, "w", encoding="utf-8") as tc:
            tc.write(transcript)

    # ── Persist to session ────────────────────────────────────────────
    s.raw_text     = transcript
    s.embed_key    = embed_key
    s.content_type = "audio"
    s.pdf_filename = save_name   # reuse field for audio file path
    # Update topic from filename if blank
    title_from_req = (request.form.get("title") or "").strip()
    if title_from_req:
        s.topic = title_from_req
    elif not s.topic or s.topic == "Untitled":
        s.topic = name.rsplit(".", 1)[0].replace("-", " ").replace("_", " ").title()
    db.session.commit()

    # ── RAG (reuse .npz embedding cache if available) ─────────────────
    h = _get_or_rebuild(sid, s)
    from rag_helper import RAGHelper, _cache_path, _load_cache
    _cache_file    = _cache_path(app.config["UPLOAD_FOLDER"], embed_key)
    _cached_chunks, _cached_emb = _load_cache(
        _cache_file, embed_key, cache_dir=app.config["UPLOAD_FOLDER"]
    )
    if _cached_chunks is not None and _cached_emb is not None:
        print(f"[AUDIO] RAG cache hit for {embed_key} — {len(_cached_chunks)} chunks", flush=True)
        h.rag_helper               = RAGHelper(
            collection_name=f"session_{sid}", sid=sid,
            cache_dir=app.config["UPLOAD_FOLDER"],
        )
        h.rag_helper.chunks           = _cached_chunks
        h.rag_helper.embeddings       = _cached_emb
        h.rag_helper._last_cache_file = _cache_file
    else:
        h.rag_helper = RAGHelper(
            collection_name=f"session_{sid}", sid=sid,
            cache_dir=app.config["UPLOAD_FOLDER"],
        )
        h.rag_helper.load_raw(transcript, source_key=embed_key)
    set_handler(sid, h)

    return jsonify({
        "ok":                True,
        "transcript_length": len(transcript),
        "chunks":            h.get_document_count(),
        "audio_url":         f"/api/session/{sid}/audio/{name}",
    })


@app.route("/api/session/<sid>/audio/<filename>")
@login_required
def serve_audio(sid, filename):
    """Serve a stored audio file for the in-session player."""
    u = current_user()
    s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    expected = f"{sid}_{filename}"
    if s.pdf_filename != expected:
        return jsonify({"error": "Not found"}), 404
    ext  = filename.rsplit(".", 1)[-1].lower()
    mime = {
        "mp3": "audio/mpeg", "wav": "audio/wav",  "m4a": "audio/mp4",
        "ogg": "audio/ogg",  "flac": "audio/flac", "webm": "audio/webm",
        "mp4": "audio/mp4",
    }.get(ext, "audio/mpeg")
    return send_from_directory(
        os.path.abspath(app.config["UPLOAD_FOLDER"]),
        expected,
        mimetype=mime,
    )


@app.route("/api/session/<sid>/save_notes", methods=["POST"])
@login_required
def api_save_user_notes(sid):
    """Save user-typed notes to the session (used by audio & text sessions)."""
    u    = current_user()
    s    = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    data = request.get_json() or {}
    s.notes = data.get("notes", "")
    db.session.commit()
    return jsonify({"ok": True})


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

@app.route("/api/session/<sid>/ocr_figures", methods=["GET"])
@login_required
def api_ocr_figures(sid):
    """Return extracted OCR figures (base64 images) for the Figures tab."""
    import json as _json
    u = current_user()
    StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    fpath = os.path.join(app.config["UPLOAD_FOLDER"], f"{sid}_figures.json")
    if not os.path.exists(fpath):
        return jsonify({"ok": True, "figures": []})
    try:
        with open(fpath) as _f:
            figures = _json.load(_f)
        return jsonify({"ok": True, "figures": figures})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "figures": []})

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

    # ── Strategy 2: yt-dlp — pull caption URLs from info dict ───────────────
    if not transcript_text:
        print("[YT] Trying yt-dlp fallback...", flush=True)
        try:
            import yt_dlp, re as _re, urllib.request as _ur

            def _pick_caption_url(caps_dict: dict):
                """Return (url, ext) — English first, then any language."""
                if not caps_dict:
                    return None, None
                for lang in ["en", "en-US", "en-GB", "en-orig"]:
                    if lang in caps_dict:
                        fmts = caps_dict[lang]
                        for pref in ["json3", "vtt", "ttml", "srv3", "srv2", "srv1"]:
                            for f in fmts:
                                if f.get("ext") == pref:
                                    return f["url"], pref
                        if fmts:
                            return fmts[0]["url"], fmts[0].get("ext", "vtt")
                for lang in caps_dict:
                    if lang.startswith("en"):
                        fmts = caps_dict[lang]
                        if fmts:
                            return fmts[0]["url"], fmts[0].get("ext", "vtt")
                for lang, fmts in caps_dict.items():
                    if fmts:
                        return fmts[0]["url"], fmts[0].get("ext", "vtt")
                return None, None

            def _parse_caption_content(content: str, ext: str) -> str:
                import json as _j
                if ext == "json3":
                    try:
                        data = _j.loads(content)
                        parts = []
                        for ev in data.get("events", []):
                            for seg in ev.get("segs", []):
                                t = seg.get("utf8", "").strip()
                                if t and t != "\n":
                                    parts.append(t)
                        txt = " ".join(parts)
                        if txt.strip():
                            return txt
                    except Exception:
                        pass
                text = _re.sub(r"<[^>]+>", " ", content)
                text = _re.sub(r"\d{2}:\d{2}[\d:.,]+\s*-->.*", "", text)
                text = _re.sub(r"^WEBVTT.*$", "", text, flags=_re.M)
                text = _re.sub(r"^\s*\d+\s*$", "", text, flags=_re.M)
                text = _re.sub(r"[ \t]+", " ", text)
                text = _re.sub(r"\n{2,}", " ", text)
                return text.strip()

            def _fetch_caption(url: str, ext: str) -> str:
                try:
                    req = _ur.Request(url, headers={
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                                      "AppleWebKit/537.36 (KHTML, like Gecko) "
                                      "Chrome/124.0.0.0 Safari/537.36"
                    })
                    with _ur.urlopen(req, timeout=20) as resp:
                        raw = resp.read().decode("utf-8", errors="ignore")
                    return _parse_caption_content(raw, ext)
                except Exception as _fe:
                    print(f"[YT] caption fetch error: {_fe}", flush=True)
                    return ""

            base_opts = {
                "skip_download":           True,
                "quiet":                   True,
                "no_warnings":             True,
                "socket_timeout":          30,
                "ignore_no_formats_error": True,
                "http_headers": {
                    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                                       "Chrome/124.0.0.0 Safari/537.36",
                    "Accept-Language": "en-US,en;q=0.9",
                },
            }

            info = None
            for pc in [None, ["web"], ["mweb"], ["ios"], ["tv_embedded"]]:
                try:
                    opts = dict(base_opts)
                    if pc:
                        opts["extractor_args"] = {"youtube": {"player_client": pc}}
                    with yt_dlp.YoutubeDL(opts) as ydl:
                        info = ydl.extract_info(
                            f"https://www.youtube.com/watch?v={video_id}",
                            download=False,
                        )
                    if info:
                        subs_found = bool(info.get("subtitles") or info.get("automatic_captions"))
                        print(f"[YT] yt-dlp info via player={pc} captions={subs_found}", flush=True)
                        if subs_found:
                            break
                except Exception as _pe:
                    print(f"[YT] player={pc} error: {_pe}", flush=True)

            if not info:
                error_log.append("yt-dlp: could not extract video info")
                raise RuntimeError("no info")

            title = info.get("title", "")
            subs  = info.get("subtitles") or {}
            auto  = info.get("automatic_captions") or {}

            print(f"[YT] subtitles langs: {list(subs.keys())[:10]}", flush=True)
            print(f"[YT] auto_captions langs: {list(auto.keys())[:10]}", flush=True)

            caption_text = ""
            for caps_key, caps_dict in [("subtitles", subs), ("automatic_captions", auto)]:
                cap_url, cap_ext = _pick_caption_url(caps_dict)
                if cap_url:
                    caption_text = _fetch_caption(cap_url, cap_ext)
                    if caption_text:
                        print(f"[YT] captions via {caps_key} ({cap_ext}, "
                              f"{len(caption_text)} chars)", flush=True)
                        break

            if caption_text:
                transcript_text = caption_text
                if title and s.topic in ("", "YouTube Video"):
                    s.topic       = title[:200]
                    s.video_title = title[:300]
            else:
                print(f"[YT] no captions found. subtitles={list(subs.keys())}, "
                      f"auto={list(auto.keys())}", flush=True)
                error_log.append(
                    f"yt-dlp: video has no captions "
                    f"(subtitles={list(subs.keys())[:5]}, "
                    f"auto={list(auto.keys())[:5]})"
                )

        except ImportError:
            error_log.append("yt-dlp not installed — run: pip install yt-dlp")
        except RuntimeError:
            pass
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

    # ── Persist transcript to DB NOW (before RAG) so restart always works ──
    s.raw_text     = transcript_text
    s.youtube_url  = url
    s.youtube_id   = video_id
    s.content_type = "youtube"
    # video_id is deterministic — same video always hits same cache entry
    import hashlib as _yl
    s.embed_key = _yl.sha256(video_id.encode()).hexdigest()[:16]
    # Also store transcript_json if not already set (yt-dlp path skips this)
    if not s.transcript_json and transcript_text:
        import json as _j2
        words  = transcript_text.split()
        chunk_size = 200
        _chunks = []
        for i in range(0, len(words), chunk_size):
            _chunks.append({"text": " ".join(words[i:i+chunk_size]), "start": i, "duration": 0})
        s.transcript_json = _j2.dumps(_chunks)
    db.session.commit()

    # ── Index into RAG ─────────────────────────────────────────────────────
    print("[YT] Indexing transcript into RAG...", flush=True)
    ok = False
    try:
        from rag_helper import RAGHelper
        h.rag_helper = RAGHelper(
            collection_name=f"session_{sid}",
            sid=sid,
            cache_dir=app.config["UPLOAD_FOLDER"],
        )
        ok = h.rag_helper.load_text_content(
            transcript_text,
            metadata={"source": url, "video_id": video_id, "type": "youtube"},
            source_key=s.embed_key,
        )
    except Exception as e:
        print(f"[YT] RAG indexing failed (non-fatal): {e}", flush=True)
        ok = False

    if ok:
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
                # "proxy": os.environ.get("PROXY_URL") or None,
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
        if h.rag_helper is None:
            from rag_helper import RAGHelper
            h.rag_helper = RAGHelper(
                collection_name=f"session_{sid}",
                sid=sid,
                cache_dir=app.config["UPLOAD_FOLDER"],
            )
        else:
            h.rag_helper.sid       = sid
            h.rag_helper.cache_dir = app.config["UPLOAD_FOLDER"]
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

    # Note: embedding cache (embed_<hash>.npz) is NOT deleted here —
    # it is content-addressed so other sessions may share it.
    # RAGHelper.clear() deletes it only when explicitly clearing a session.
    db.session.delete(s)
    db.session.commit()
    _handlers.pop(sid, None)
    return jsonify({"ok": True})

@app.route("/api/session/<sid>/annotations", methods=["GET"])
@login_required
def api_get_annotations(sid):
    u = current_user()
    s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    try:
        import json as _j
        anns = _j.loads(s.annotations_json or "[]")
    except Exception:
        anns = []
    return jsonify({"ok": True, "annotations": anns})

@app.route("/api/session/<sid>/annotations", methods=["POST"])
@login_required
def api_save_annotations(sid):
    u = current_user()
    s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    data = request.get_json() or {}
    import json as _j
    s.annotations_json = _j.dumps(data.get("annotations", []))
    db.session.commit()
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


@app.route("/api/session/<sid>/text_chapters", methods=["POST"])
@login_required
def api_text_chapters(sid):
    """Generate AI chapters/sections from pasted text using the session handler."""
    u = current_user()
    s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    if not s.raw_text:
        return jsonify({"ok": False, "error": "No text content"}), 400
    h = _get_or_rebuild(sid, s)
    try:
        # Get RAG context or fall back to raw_text directly
        ctx = h._full_context(k=15) if h.rag_helper else s.raw_text[:8000]
        prompt = (
            "Split the following text into logical chapters or sections. "
            "Return ONLY a valid JSON array — no explanation, no markdown, no backticks:\n"
            '[{"title":"Chapter title","summary":"2-3 sentence summary","start_snippet":"first 8 words of this section..."}]'
            f"\n\nTEXT:\n{ctx}"
        )
        agent  = h.agents.tutor_agent()
        result = h._run_agent(agent, prompt)
        import re as _re, json as _j
        m = _re.search(r'\[.*?\]', result, _re.DOTALL)
        chapters = _j.loads(m.group(0)) if m else []
        return jsonify({"ok": True, "chapters": chapters})
    except Exception as e:
        import traceback; print(traceback.format_exc())
        return jsonify({"ok": False, "error": str(e)}), 500

@app.route("/api/session/<sid>/text_explain", methods=["POST"])
@login_required
def api_text_explain(sid):
    """Explain a selected passage from the text."""
    u    = current_user()
    s    = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    h    = _get_or_rebuild(sid, s)
    data = request.get_json() or {}
    selection = data.get("text", "").strip()[:2000]
    if not selection:
        return jsonify({"ok": False, "error": "No text selected"}), 400
    try:
        prompt = f"Explain the following passage clearly and concisely, as if teaching a student:\n\n\"{selection}\""
        result = h.get_tutoring(student_question=selection, context=f"Explain this passage clearly and concisely, as if teaching a student.")
        return jsonify({"ok": True, "result": result})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/user/model", methods=["POST"])
@login_required
def api_set_model():
    """Save the user's preferred model selection."""
    u    = current_user()
    data = request.get_json() or {}
    mid  = data.get("model_id", "").strip()
    m    = get_model(mid)
    if not m:
        return jsonify({"ok": False, "error": "Unknown model"}), 400
    u.pref_model_id = mid
    db.session.commit()

    # Evict cached handlers for ALL this user's sessions so next call rebuilds
    # with the newly selected model instead of the stale in-memory one.
    user_sessions = StudySession.query.filter_by(user_id=u.id).all()
    for us in user_sessions:
        _handlers.pop(us.sid, None)
    print(f"[Model] Switched to {mid} — evicted {len(user_sessions)} cached handlers", flush=True)

    return jsonify({"ok": True, "model_id": mid, "label": m["label"]})

@app.route("/api/user/models", methods=["GET"])
@login_required
def api_list_models():
    """Return all models with availability status."""
    return jsonify({"ok": True, "models": available_models()})



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