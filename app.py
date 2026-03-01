
"""
StudyAI — Flask Application
Multi-Agent Study Assistant with full auth, history, and AI tutoring
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
    created_at    = db.Column(db.DateTime,    default=datetime.utcnow)
    interactions  = db.relationship("Interaction", backref="study_session", lazy=True,
                                    cascade="all, delete-orphan")

class Interaction(db.Model):
    id         = db.Column(db.Integer, primary_key=True)
    session_id = db.Column(db.Integer, db.ForeignKey("study_session.id"), nullable=False)
    kind       = db.Column(db.String(40), default="chat")   # chat | quiz | rag
    question   = db.Column(db.Text,  default="")
    answer     = db.Column(db.Text,  default="")
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

# ── In-memory handler store ────────────────────────────────────────────────────
_handlers: dict = {}

def get_handler(sid: str):
    return _handlers.get(sid)

def set_handler(sid: str, h):
    _handlers[sid] = h

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
    return User.query.get(uid) if uid else None

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
    return render_template("session.html", user=u, study=s)

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
    )
    db.session.add(s)
    db.session.commit()

    # Spin up handler
    from agent_handler import StudyAssistantHandler
    h = StudyAssistantHandler(
        topic=s.topic, subject_category=s.category,
        knowledge_level=s.knowledge_lvl, learning_goal=s.learning_goal,
        time_available=s.time_avail, learning_style=s.style,
        model_name=s.model, provider=s.provider
    )
    set_handler(s.sid, h)
    return jsonify({"ok": True, "sid": s.sid})

@app.route("/api/session/<sid>/analyze", methods=["POST"])
@login_required
def api_analyze(sid):
    u = current_user()
    s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    h = get_handler(sid)
    if not h:
        s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
        h = StudyAssistantHandler(
            s.topic, s.category, s.knowledge_lvl,
            s.learning_goal, s.time_avail, s.style,
            s.model, s.provider
        )
        set_handler(sid, h)
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
    h = get_handler(sid)
    if not h:
        s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
        h = StudyAssistantHandler(
            s.topic, s.category, s.knowledge_lvl,
            s.learning_goal, s.time_avail, s.style,
            s.model, s.provider
        )
        set_handler(sid, h)
    try:
        result = h.create_roadmap(s.analysis)
        s.roadmap = result
        db.session.commit()
        return jsonify({"ok": True, "result": result})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/session/<sid>/resources", methods=["POST"])
@login_required
def api_resources(sid):
    u = current_user()
    s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    h = get_handler(sid)
    if not h:
        s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
        h = StudyAssistantHandler(
            s.topic, s.category, s.knowledge_lvl,
            s.learning_goal, s.time_avail, s.style,
            s.model, s.provider
        )
        set_handler(sid, h)
    try:
        result = h.find_resources()
        s.resources = result
        db.session.commit()
        return jsonify({"ok": True, "result": result})
    except Exception as e:
        fallback = f"## Resources for {s.topic}\n\nResource search encountered an error. Please use the Refresh button in the Resources tab to retry.\n\nError: {str(e)}"
        s.resources = fallback
        db.session.commit()
        return jsonify({"ok": True, "result": fallback})
        

@app.route("/api/session/<sid>/quiz", methods=["POST"])
@login_required
def api_quiz(sid):
    u    = current_user()
    s    = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    h    = get_handler(sid)
    data = request.get_json()
    if not h:
        s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
        h = StudyAssistantHandler(
            s.topic, s.category, s.knowledge_lvl,
            s.learning_goal, s.time_avail, s.style,
            s.model, s.provider
        )
        set_handler(sid, h)
    try:
        result = h.generate_quiz(
            difficulty_level=data.get("difficulty", "intermediate"),
            focus_areas=data.get("focus", "general"),
            num_questions=int(data.get("num_questions", 10))
        )
        inter = Interaction(session_id=s.id, kind="quiz",
                            question=f"Quiz — {data.get('difficulty')} · {data.get('num_questions')}q",
                            answer=result)
        db.session.add(inter)
        db.session.commit()
        return jsonify({"ok": True, "result": result})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/session/<sid>/tutor", methods=["POST"])
@login_required
def api_tutor(sid):
    u    = current_user()
    s    = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    h    = get_handler(sid)
    data = request.get_json()
    question = data.get("question", "")
    context  = data.get("context", "")
    if not h:
        s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
        h = StudyAssistantHandler(
            s.topic, s.category, s.knowledge_lvl,
            s.learning_goal, s.time_avail, s.style,
            s.model, s.provider
        )
        set_handler(sid, h)
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

@app.route("/api/session/<sid>/upload_doc", methods=["POST"])
@login_required
def api_upload_doc(sid):
    u = current_user()
    s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    h = get_handler(sid)
    
    if not h:
        s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
        h = StudyAssistantHandler(
            s.topic, s.category, s.knowledge_lvl,
            s.learning_goal, s.time_avail, s.style,
            s.model, s.provider
        )
        set_handler(sid, h)
        
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400
    f    = request.files["file"]
    name = secure_filename(f.filename)
    if not name:
        return jsonify({"error": "Invalid filename"}), 400
    ext  = name.rsplit(".", 1)[-1].lower()
    if ext not in ("pdf", "txt"):
        return jsonify({"error": "Only PDF and TXT supported"}), 400
    path = os.path.join(app.config["UPLOAD_FOLDER"], f"{sid}_{name}")
    f.save(path)
    ft   = "pdf" if ext == "pdf" else "text"
    ok   = h.add_document_to_rag(path, ft)
    size = round(os.path.getsize(path) / 1024, 1)
    os.remove(path)
    return jsonify({"ok": ok, "name": name, "size": size,
                    "type": ext, "chunks": h.get_document_count()})

@app.route("/api/session/<sid>/rag_query", methods=["POST"])
@login_required
def api_rag_query(sid):
    u    = current_user()
    s    = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
    h    = get_handler(sid)
    data = request.get_json()
    question = data.get("question", "")
    if not h:
        s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
        h = StudyAssistantHandler(
            s.topic, s.category, s.knowledge_lvl,
            s.learning_goal, s.time_avail, s.style,
            s.model, s.provider
        )
        set_handler(sid, h)
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
    if h:
        h.clear_documents()
    return jsonify({"ok": True})

@app.route("/api/session/<sid>/delete", methods=["DELETE"])
@login_required
def api_delete_session(sid):
    u = current_user()
    s = StudySession.query.filter_by(sid=sid, user_id=u.id).first_or_404()
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
        "sid": s.sid, "topic": s.topic, "category": s.category,
        "knowledge_level": s.knowledge_lvl, "learning_goal": s.learning_goal,
        "time_available": s.time_avail, "style": s.style,
        "analysis": s.analysis, "roadmap": s.roadmap, "resources": s.resources,
        "doc_count": doc_count,
        "created_at": s.created_at.strftime("%b %d, %Y"),
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
        "total_sessions": total_s,
        "total_interactions": total_i,
        "recent": [{"sid": s.sid, "topic": s.topic,
                    "category": s.category,
                    "date": s.created_at.strftime("%b %d")} for s in recent],
    })

# ── Init ───────────────────────────────────────────────────────────────────────
with app.app_context():
    db.create_all()

if __name__ == "__main__":
    app.run(debug=True, port=5000, threaded=True)