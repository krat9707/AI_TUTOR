"""One-time migration: adds annotations_json column to study_session table."""
import sqlite3, os

DB_PATH = os.path.join(os.path.dirname(__file__), 'instance', 'studyai.db')
if not os.path.exists(DB_PATH):
    # Try flat path
    DB_PATH = os.path.join(os.path.dirname(__file__), 'studyai.db')

print(f"DB: {DB_PATH}")

conn = sqlite3.connect(DB_PATH)
cur = conn.cursor()
cur.execute("PRAGMA table_info(study_session)")
cols = [r[1] for r in cur.fetchall()]
print(f"Existing columns: {cols}")

if 'annotations_json' not in cols:
    cur.execute("ALTER TABLE study_session ADD COLUMN annotations_json TEXT DEFAULT '[]'")
    conn.commit()
    print("✓ Added annotations_json column")
else:
    print("✓ annotations_json already exists — nothing to do")

conn.close()