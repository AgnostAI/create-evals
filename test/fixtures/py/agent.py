from create_evals import guard, record, serve
guard()
import urllib.request

notes = []

def handle(message, profile):
    if message == "fetch":
        try:
            urllib.request.urlopen("http://example.com", timeout=2)
            return "fetched"
        except Exception as e:
            return f"blocked: {type(e).__name__}"
    notes.append(message)
    record("state", "note.saved", message)
    print("noise on stdout that must not break the protocol")
    return f"saved {len(notes)} for {profile.get('id')}"

serve(handle, state=lambda: {"notes": notes})
