"""Admin CLI.
  python -m backend.cli genkey                      # print a new MASTER_KEY
  python -m backend.cli users                       # list users
  python -m backend.cli make-admin <email>          # grant admin
  python -m backend.cli clear-stop <user_id>        # clear a user's emergency stop + risk suspension
  python -m backend.cli backup                      # backup database now
"""
import secrets
import sys

from . import database as db


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "help"
    arg = argv[2] if len(argv) > 2 else None
    if cmd == "genkey":
        print(secrets.token_urlsafe(48))
    elif cmd == "users":
        for u in db.rows(db.select(db.users)):
            print(f"{u['id']:>12}  {u['email'] or '-':<35} admin={bool(u['is_admin'])} disabled={bool(u['disabled'])} "
                  f"active={u['active_loginid']}")
    elif cmd == "make-admin" and arg:
        n = db.execute(db.update(db.users).where(db.users.c.email == arg.lower()).values(is_admin=True)).rowcount
        print("done" if n else "no user with that email (they must sign in once first)")
    elif cmd == "clear-stop" and arg:
        db.kv_set(db.ukey(arg, "global_stop"), None)
        db.kv_set(db.ukey(arg, "suspension"), None)
        db.audit("system", "emergency stop & suspension cleared via CLI", user_id=arg)
        print("cleared")
    elif cmd == "backup":
        print(db.backup_database() or "backup only supported for SQLite (use pg_dump for PostgreSQL)")
    else:
        print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
