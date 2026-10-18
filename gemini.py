"""Gemini: turns a small spending summary into plain-English insights.

Python does all the math (see server.py's dashboard). Gemini only explains the
numbers it is given, and returns JSON that matches the Insights schema below.

Setup:
  1. Get a free key at https://aistudio.google.com/apikey
  2. Add a line to .env:   GEMINI_API_KEY=your_key_here
  3. venv\\Scripts\\pip install -r requirements.txt   (adds google-genai)

Two model tiers (optional in .env / Railway Variables):
  fast  - quick, simple jobs (the insights panel, health checks)
          GEMINI_MODEL_FAST (default gemini-flash-lite-latest), GEMINI_THINKING_FAST (default minimal)
  smart - heavier reasoning (goal coach, plans with math and trade-offs)
          GEMINI_MODEL_SMART (default GEMINI_MODEL, i.e. gemini-3.8-flash), GEMINI_THINKING_SMART (default low)
If the fast model isn't available to your key, the app quietly falls back to GEMINI_MODEL.
Thinking levels: minimal|low|medium|high, or "default" to leave it to the model.
If there's no key, or Gemini fails, callers get None and the app keeps working.
"""
import hashlib
import json
import os
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor

from dotenv import load_dotenv
from pydantic import BaseModel

load_dotenv()

MODEL = os.getenv("GEMINI_MODEL", "gemini-3.8-flash")   # the base model, and the fallback for both tiers
TIERS = {
    "fast": {"model": os.getenv("GEMINI_MODEL_FAST", "gemini-flash-lite-latest"),
             "thinking": os.getenv("GEMINI_THINKING_FAST", os.getenv("GEMINI_THINKING", "minimal"))},
    "smart": {"model": os.getenv("GEMINI_MODEL_SMART", MODEL),
              "thinking": os.getenv("GEMINI_THINKING_SMART", "low")},
    # The goal coach is a live chat, so it uses the quick model: fast answers matter more there.
    "coach": {"model": os.getenv("GEMINI_MODEL_COACH", os.getenv("GEMINI_MODEL_FAST", "gemini-flash-lite-latest")),
              "thinking": os.getenv("GEMINI_THINKING_COACH", "minimal")},
}
# If a tier's model isn't available to this key, try these next (Google's auto-updating names).
FALLBACK_MODELS = [MODEL, "gemini-flash-lite-latest", "gemini-flash-latest"]
_bad_models: set[str] = set()
CACHE_SECONDS = 15 * 60          # reuse an answer for the same numbers for 15 minutes

RULES = (
    "You are a friendly money coach inside a student banking app called Gatorstar. "
    "Use ONLY the numbers in the data you are given; never invent or recalculate figures. "
    "Write in second person, short and specific, with dollar amounts from the data. "
    "Give educational suggestions, not financial or investment advice. "
    "If a value is null, it means there isn't enough data; don't guess."
)


class Insights(BaseModel):
    headline: str            # one sentence, the main takeaway
    persona: str             # 2-3 word spending style, e.g. "Steady saver"
    insights: list[str]      # 2-3 observations
    tips: list[str]          # 1-2 practical suggestions


_client = None
_cache: dict[str, tuple[float, dict]] = {}

# Speed:
#  - TIERS (top of file): simple jobs use a light, fast model with minimal "thinking";
#    the goal coach uses the stronger model with a little more thinking.
#  - prewarm(): the dashboard starts Gemini in the background as soon as it has the
#    numbers, so by the time the Insights panel asks, the answer is (nearly) ready.
#    Requests for the same numbers share one Gemini call.
_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="gemini")
_in_flight: dict[str, Future] = {}
_lock = threading.Lock()
_no_thinking: set[str] = set()  # models that rejected a thinking level


def available() -> bool:
    return bool(os.getenv("GEMINI_API_KEY"))


TIMEOUT_MS = int(os.getenv("GEMINI_TIMEOUT_MS", "30000"))  # give up on a stuck call after this
_client_lock = threading.Lock()


def _get_client():
    global _client
    with _client_lock:
        if _client is None:
            from google import genai   # imported here so the app still starts without the package
            from google.genai import types
            # reads GEMINI_API_KEY; a timeout so one stuck call can't hang a page
            _client = genai.Client(http_options=types.HttpOptions(timeout=TIMEOUT_MS))
    return _client


# ---------- Health: is Gemini actually answering? ----------
# Every real call records how it went, so the status usually costs nothing extra.
# check() sends a tiny test prompt when nothing has been heard for a while.
STATUS_FRESH_SECONDS = 5 * 60
_status = {"state": "unknown", "latency_ms": None, "checked_at": None, "error": None, "last_model": None}
_checking = threading.Event()


def _record(ok: bool, started: float, error: Exception | None = None, model: str | None = None):
    _status.update(
        last_model=model,
        state="online" if ok else "offline",
        latency_ms=round((time.time() - started) * 1000),
        checked_at=time.time(),
        error=None if ok else _short_error(error),
    )


def _short_error(e) -> str:
    text = str(e)
    for hint, nice in (("API key", "The API key was rejected"), ("PERMISSION", "The API key isn't allowed to use this model"),
                       ("RESOURCE_EXHAUSTED", "Rate limit or quota reached"), ("429", "Rate limit or quota reached"),
                       ("not found", "That Gemini model wasn't found"), ("timed out", "Gemini took too long to answer"),
                       ("UNAVAILABLE", "Gemini is temporarily unavailable"), ("503", "Gemini is temporarily unavailable")):
        if hint.lower() in text.lower():
            return nice
    return text[:160]


class _Ping(BaseModel):
    ok: bool


def check() -> dict:
    """Send a tiny test prompt now and return the fresh status."""
    if available() and not _checking.is_set():
        _checking.set()
        try:
            generate_json("Answer with ok=true.", "Health check.", _Ping)
        except Exception:
            pass  # generate_json already recorded the failure
        finally:
            _checking.clear()
    return status()


def status(refresh_if_stale: bool = True) -> dict:
    """Current Gemini status for the header badge. Re-checks in the background when stale."""
    if not available():
        return {"state": "not_configured", "model": MODEL, "models": {t: v["model"] for t, v in TIERS.items()}, "latency_ms": None, "checked_at": None,
                "error": "No GEMINI_API_KEY is set on the server"}
    stale = _status["checked_at"] is None or time.time() - _status["checked_at"] > STATUS_FRESH_SECONDS
    if refresh_if_stale and stale and not _checking.is_set():
        threading.Thread(target=check, daemon=True, name="gemini-check").start()
    state = "checking" if _status["state"] == "unknown" else _status["state"]
    return {**_status, "state": state, "model": MODEL, "models": {t: v["model"] for t, v in TIERS.items()},
            "age_seconds": round(time.time() - _status["checked_at"]) if _status["checked_at"] else None}


def warm_up() -> None:
    """At server start: load the Gemini library, open the connection and check the key,
    in the background, so the first real request doesn't pay for all of that."""
    if available():
        threading.Thread(target=check, daemon=True, name="gemini-warmup").start()


def _key(summary: dict) -> str:
    return hashlib.sha256(json.dumps(summary, sort_keys=True).encode()).hexdigest()


def _cached(key: str) -> dict | None:
    hit = _cache.get(key)
    return hit[1] if hit and time.time() - hit[0] < CACHE_SECONDS else None


def _next_model(current: str) -> str | None:
    return next((m for m in FALLBACK_MODELS if m != current and m not in _bad_models), None)


def generate_json_within(seconds: float, system: str, prompt: str, schema: type[BaseModel], tier: str = "fast") -> dict:
    """generate_json, but give up after `seconds` (raises TimeoutError). The call itself
    keeps running in the background and still updates the status badge."""
    return _pool.submit(generate_json, system, prompt, schema, tier).result(timeout=seconds)


def _is_missing_model(text: str) -> bool:
    return any(t in text for t in ("not found", "404", "not supported", "permission", "403", "is not available"))


def generate_json(system: str, prompt: str, schema: type[BaseModel], tier: str = "fast") -> dict:
    """One Gemini call that must answer as JSON matching `schema`. Raises on failure.
    tier "fast" = light model for simple jobs, "smart" = stronger model for heavier reasoning.
    Used by the insights panel here and by the goal coach (goal_coach.py)."""
    from google.genai import types
    cfg = TIERS.get(tier, TIERS["fast"])
    started = time.time()

    def call(model: str):
        settings = dict(system_instruction=system, response_mime_type="application/json",
                        response_json_schema=schema.model_json_schema())
        if cfg["thinking"] != "default" and model not in _no_thinking:
            try:
                settings["thinking_config"] = types.ThinkingConfig(thinking_level=cfg["thinking"])
            except Exception:  # older google-genai without thinking levels
                _no_thinking.add(model)
        return _get_client().models.generate_content(model=model, contents=prompt, config=types.GenerateContentConfig(**settings))

    model = cfg["model"]
    try:
        try:
            response = call(model)
        except Exception as e:
            text = str(e).lower()
            if "think" in text and model not in _no_thinking:
                print(f"Gemini model {model} rejected thinking level {cfg['thinking']}; retrying without it.")
                _no_thinking.add(model)
            elif _is_missing_model(text) and _next_model(model):
                # This key can't use the tier's model: switch to the next one from now on.
                _bad_models.add(model)
                nxt = _next_model(model)
                print(f"Gemini model {model} isn't available ({str(e)[:80]}); using {nxt} for {tier} requests.")
                cfg["model"] = model = nxt
            elif any(t in text for t in ("503", "unavailable", "500", "internal", "timed out", "timeout")):
                time.sleep(0.8)  # brief hiccup on Google's side: one quick retry
            else:
                raise
            response = call(model)
        result = schema.model_validate_json(response.text).model_dump()
    except Exception as e:
        _record(False, started, e, model)
        raise
    _record(True, started, None, model)
    return result


def _generate(summary: dict) -> dict:
    return generate_json(RULES, "Explain this customer's spending for the period:\n" + json.dumps(summary), Insights)


def _start(summary: dict) -> tuple[str, Future | None, dict | None]:
    """Cached answer, or the (possibly already running) Gemini call for these numbers."""
    key = _key(summary)
    done = _cached(key)
    if done is not None:
        return key, None, done
    with _lock:
        job = _in_flight.get(key)
        if job is None:
            job = _pool.submit(_generate, summary)
            _in_flight[key] = job

            def finished(j, key=key):
                with _lock:
                    _in_flight.pop(key, None)
                if j.exception() is None:
                    _cache[key] = (time.time(), j.result())
                else:  # network, quota, bad key, bad JSON: the app keeps working without it
                    print(f"Gemini insights failed: {j.exception()}")
            job.add_done_callback(finished)
    return key, job, None


def prewarm(summary: dict) -> None:
    """Start working on these numbers in the background (no waiting)."""
    if available():
        _start(summary)


def explain(summary: dict) -> dict | None:
    """Return Insights as a dict, or None if Gemini isn't set up or the call fails."""
    if not available():
        return None
    _, job, done = _start(summary)
    if done is not None:
        return done
    try:
        return job.result(timeout=45)
    except Exception:
        return None
