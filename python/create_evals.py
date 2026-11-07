"""create-evals helper for agents written in Python.

The TypeScript binding starts this process once per conversation with `spawnSession(ctx, [...])`
and speaks a line protocol over stdin/stdout:

  in:  {"message": "...", "profile": {...}}                          one JSON line per user message
  out: @@CREATE_EVALS@@{"reply": "...", "events": [...], "state": ...} one line per message

Everything else your agent prints is passed through as logs. Typical entry point (evals/run_agent.py):

    from create_evals import guard, record, serve
    guard()                       # before importing your app: blocks all hosts but model APIs
    from myapp.agent import Agent

    agent = Agent()
    serve(lambda message, profile: agent.reply(message), state=lambda: agent.snapshot())
"""
import json
import os
import socket
import sys

MARKER = "@@CREATE_EVALS@@"
MODEL_HOSTS = {"api.anthropic.com", "api.openai.com"}
_events = []
_real_stdout = sys.stdout


def record(kind, name, input=None, output=None):
    """Log a tool call or state change so the reviewer can check what the agent said against what it did."""
    _events.append({"kind": kind, "name": name, "input": input, "output": output})


def guard(allow=()):
    """Refuse DNS lookups and connections to anything but model APIs, CREATE_EVALS_ALLOW and `allow`.

    Covers httpx, requests, urllib and raw sockets. Call it before importing your app.
    """
    allowed = set(MODEL_HOSTS) | set(allow) | {h for h in os.environ.get("CREATE_EVALS_ALLOW", "").split(",") if h}
    allowed_ips = set()
    real_getaddrinfo, real_connect, real_connect_ex = socket.getaddrinfo, socket.socket.connect, socket.socket.connect_ex

    def permitted(host):
        return host in allowed or any(a.startswith("*.") and host.endswith(a[1:]) for a in allowed)

    def getaddrinfo(host, *args, **kwargs):
        name = host.decode() if isinstance(host, bytes) else host
        if name is None or permitted(name):
            result = real_getaddrinfo(host, *args, **kwargs)
            allowed_ips.update(info[4][0] for info in result)
            return result
        record("error", "network-blocked", name)
        raise socket.gaierror(f"create-evals blocked a request to {name}. Fake it, or add it to allowHosts.")

    def check(sock, address):
        if sock.family in (socket.AF_INET, socket.AF_INET6) and address[0] not in allowed_ips:
            record("error", "network-blocked", address[0])
            raise ConnectionRefusedError(f"create-evals blocked a connection to {address[0]}.")

    def connect(sock, address):
        check(sock, address)
        return real_connect(sock, address)

    def connect_ex(sock, address):
        check(sock, address)
        return real_connect_ex(sock, address)

    socket.getaddrinfo = getaddrinfo
    socket.socket.connect = connect
    socket.socket.connect_ex = connect_ex


def serve(handle, state=None):
    """Answer messages until stdin closes. `handle(message, profile)` returns the reply text."""
    sys.stdout = sys.stderr  # the agent's own prints mustn't corrupt the protocol
    for line in sys.stdin:
        if not line.strip():
            continue
        req = json.loads(line)
        _events.clear()
        try:
            reply = handle(req["message"], req.get("profile") or {})
            out = {"reply": "" if reply is None else str(reply)}
        except Exception as e:  # report, don't die: the conversation records it as an agent error
            import traceback
            out = {"reply": "", "error": "".join(traceback.format_exception_only(type(e), e)).strip()}
        out["events"] = list(_events)
        if state:
            try:
                out["state"] = state()
            except Exception as e:
                out["state"] = {"error": str(e)}
        _real_stdout.write(MARKER + json.dumps(out, default=str) + "\n")
        _real_stdout.flush()
